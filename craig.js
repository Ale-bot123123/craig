/*
 * Copyright (c) 2017, 2018 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

const cp = require("child_process");
const fs = require("fs");
const EventEmitter = require("events");
const https = require("https");
const Discord = require("eris");
const ogg = require("./craig-ogg.js");

// Are these constants SERIOUSLY not exposed by Eris at all???
const TEXT_CHANNEL = 0;
const DM_CHANNEL = 1;
const VOICE_CHANNEL = 2;

const client = new Discord(config.token);
const clients = [client]; // For secondary connections
const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const defaultConfig = require("./default-config.js");

for (var ck in defaultConfig)
    if (!(ck in config))
        config[ck] = defaultConfig[ck];

function accessSyncer(file) {
    try {
        fs.accessSync(file);
    } catch (ex) {
        return false;
    }
    return true;
}

// Convenience functions to turn entities into name#id strings:
function nameId(entity) {
    var nick = "";
    if ("nick" in entity && entity.nick) {
        nick = entity.nick;
    } else if ("username" in entity) {
        nick = entity.username;
    } else if ("name" in entity) {
        nick = entity.name;
    }
    return nick + "#" + entity.id;
}

// A precomputed Opus header, made by node-opus 
const opusHeader = [
    Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 0x01, 0x02,
        0x00, 0x0f, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, 0x09, 0x00,
        0x00, 0x00, 0x6e, 0x6f, 0x64, 0x65, 0x2d, 0x6f, 0x70, 0x75, 0x73, 0x00,
        0x00, 0x00, 0x00, 0xff])
];

// Our guild membership status
var guildMembershipStatus = {};
if (accessSyncer("craig-guild-membership-status.json")) {
    try {
        var journal = JSON.parse("["+fs.readFileSync("craig-guild-membership-status.json", "utf8")+"]");
        guildMembershipStatus = journal[0];
        for (var ji = 1; ji < journal.length; ji++) {
            var step = journal[ji];
            if ("v" in step)
                guildMembershipStatus[step.k] = step.v;
            else
                delete guildMembershipStatus[step.k];
        }
    } catch (ex) {}
}
var guildMembershipStatusF = fs.createWriteStream("craig-guild-membership-status.json", "utf8");
guildMembershipStatusF.write(JSON.stringify(guildMembershipStatus) + "\n");

function guildRefresh(guild) {
    if (dead) return;
    var step = {"k": guild.id, "v": (new Date().getTime())};
    guildMembershipStatus[step.k] = step.v;
    guildMembershipStatusF.write("," + JSON.stringify(step) + "\n");
}

// Log in
client.connect();

// If there are secondary Craigs, log them in
for (var si = 0; si < config.secondary.length; si++) {
    clients.push(new Discord(config.secondary[si].token));
    clients[si+1].connect();
}

var log;
if ("log" in config) {
    const logStream = fs.createWriteStream(config.log, {"flags": "a"});
    log = function(line) {
        logStream.write((new Date().toISOString()) + ": " + line + "\n");
    }
} else {
    log = function(line) {
        console.log((new Date().toISOString()) + ": " + line);
    }
}

// Set to true when we've been gracefully restarted
var dead = false;

// Active recordings by guild, channel
var activeRecordings = {};

// A map user ID -> rewards
var rewards = {};
var defaultFeatures = {"limits": config.limits};

// Function to respond to a message by any means necessary
function reply(msg, dm, prefix, pubtext, privtext) {
    if (dm) {
        // Try to send the message privately
        if (typeof privtext === "undefined")
            privtext = pubtext;
        else
            privtext = pubtext + "\n\n" + privtext;
        log("Reply to " + nameId(msg.author) + ": " + privtext);

        function rereply(err) {
            reply(msg, false, prefix, "I can't send you direct messages. " + pubtext);
        }
        try {
            msg.author.getDMChannel().then((dmc) => {
                dmc.createMessage(privtext).catch(rereply);
            }).catch(rereply);
        } catch (ex) {
            rereply();
        }
        return;
    }

    // Try to send it by conventional means
    log("Public reply to " + nameId(msg.author) + ": " + pubtext);
    msg.channel.createMessage(
        msg.author.mention + ", " +
        (prefix ? (prefix + " <(") : "") +
        pubtext +
        (prefix ? ")" : "")).catch((err) => {

    log("Failed to reply to " + nameId(msg.author));

    // If this wasn't a guild message, nothing to be done
    var guild = msg.channel.guild;
    if (!guild)
        return;

    /* We can't get a message to them properly, so try to get a message out
     * that we're stimied */
    guild.channels.find((channel) => {
        if (channel.type !== TEXT_CHANNEL)
            return false;

        var perms = channel.permissionsOf(client.user.id);
        if (!perms)
            return false;

        if (perms.has("sendMessages")) {
            // Finally!
            channel.createMessage("Sorry to spam this channel, but I don't have privileges to respond in the channel you talked to me in! Please give me permission to talk :(");
            return true;
        }

        return false;
    });

    try {
        // Give ourself a name indicating error
        guild.editNickname("ERROR CANNOT SEND MESSAGES").catch(() => {});
    } catch (ex) {}

    });
}

// An event emitter for whenever we start or stop any recording
class RecordingEvent extends EventEmitter {}
const recordingEvents = new RecordingEvent();

// Get our currect active recordings from the launcher
if (process.channel) {
    process.send({t:"requestActiveRecordings"});
    process.on("message", (msg) => {
        if (typeof msg !== "object")
            return;
        switch (msg.t) {
            case "activeRecordings":
                for (var gid in msg.activeRecordings) {
                    var ng = msg.activeRecordings[gid];
                    if (!(gid in activeRecordings))
                        activeRecordings[gid] = {};
                    var g = activeRecordings[gid];
                    for (var cid in ng) {
                        if (cid in g)
                            continue;
                        var nc = ng[cid];
                        (function(gid, cid, nc) {
                            var rec = g[cid] = {
                                id: nc.id,
                                accessKey: nc.accessKey,
                                connection: {
                                    channel: {
                                        members: {
                                            size: (nc.size?nc.size:1)
                                        }
                                    },
                                    disconnect: function() {
                                        delete activeRecordings[gid][cid];
                                        if (Object.keys(activeRecordings[gid]).length === 0)
                                            delete activeRecordings[gid];
                                    }
                                }
                            };
                            setTimeout(() => {
                                try {
                                    if (activeRecordings[gid][cid] === rec)
                                        rec.connection.disconnect();
                                } catch (ex) {}
                            }, 1000*60*60*6);
                        })(gid, cid, nc);
                    }
                }
                break;
        }
    });
}

// Get the features for a given user
function features(id) {
    var r = rewards[id];
    if (r) return r;
    return defaultFeatures;
}

// Our recording session proper
function session(msg, prefix, rec) {
    var guild = rec.guild;
    var connection = rec.connection;
    var limits = rec.limits;
    var id = rec.id;
    var client = rec.client;
    var nick = rec.nick;

    function sReply(dm, pubtext, privtext) {
        reply(msg, dm, prefix, pubtext, privtext);
    }

    var receiver = connection.receive("opus");

    // Time limit
    const partTimeout = setTimeout(() => {
        log("Terminating " + id + ": Time limit.");
        sReply(true, "Sorry, but you've hit the recording time limit. Recording stopped.");
        rec.disconnected = true;
        connection.disconnect();
    }, limits.record * 60*60*1000);

    // Rename ourself to indicate that we're recording
    try {
        guild.editNickname(nick + " [RECORDING]").catch((err) => {
            log("Terminating " + id + ": Lack nick change permission.");
            sReply(true, "I do not have permission to change my nickname on this server. I will not record without this permission.");
            rec.disconnected = true;
            connection.disconnect();
        });
    } catch (ex) {}

    // Log it
    try {
        log("Started recording " + nameId(connection.channel) + "@" + nameId(connection.channel.guild) + " with ID " + id);
    } catch(ex) {}
    recordingEvents.emit("start", rec);

    // Track numbers for each active user
    var userTrackNos = {};

    // Packet numbers for each active user
    var userPacketNos = {};

    // Our current track number
    var trackNo = 1;

    // Set up our recording OGG header and data file
    var startTime = process.hrtime();
    var recFileBase = "rec/" + id + ".ogg";

    // The amount of data I've recorded
    var size = 0;

    // Keep track and disconnect if we seem unused
    var lastSize = 0;
    var usedMinutes = 0;
    var unusedMinutes = 0;
    var warned = false;
    const useInterval = setInterval(() => {
        if (size != lastSize) {
            lastSize = size;
            usedMinutes++;
            unusedMinutes = 0;
        } else {
            unusedMinutes++;
            if (usedMinutes === 0) {
                // No recording at all!
                log("Terminating " + id + ": No data.");
                sReply(true, "I'm not receiving any data! Disconnecting.");
                rec.disconnected = true;
                connection.disconnect();
                return;
            } else if (unusedMinutes === 5 && !warned) {
                sReply(true, "Hello? I haven't heard anything for five minutes. Has something gone wrong, are you just taking a break, or have you forgotten to `:craig:, leave` to stop the recording? If it's just a break, disregard this message!");
                sReply(false, "Hello? I haven't heard anything for five minutes. Has something gone wrong, are you just taking a break, or have you forgotten to `:craig:, leave` to stop the recording? If it's just a break, disregard this message!");
                warned = true;
            }
        }
    }, 60000);

    // Set up our recording streams
    var recFHStream = [
        fs.createWriteStream(recFileBase + ".header1"),
        fs.createWriteStream(recFileBase + ".header2")
    ];
    var recFStream = fs.createWriteStream(recFileBase + ".data");

    // And our ogg encoders
    function write(stream, granulePos, streamNo, packetNo, chunk, flags) {
        size += chunk.length;
        if (config.hardLimit && size >= config.hardLimit) {
            log("Terminating " + id + ": Size limit.");
            reply(true, "Sorry, but you've hit the recording size limit. Recording stopped.");
            rec.disconnected = true;
            connection.disconnect();
        } else {
            stream.write(granulePos, streamNo, packetNo, chunk, flags);
        }
    }
    var recOggHStream = [ new ogg.OggEncoder(recFHStream[0]), new ogg.OggEncoder(recFHStream[1]) ];
    var recOggStream = new ogg.OggEncoder(recFStream);

    // Function to encode a single Opus chunk to the ogg file (exists only to work around an error)
    function encodeChunk(oggStream, streamNo, packetNo, chunk) {
        var chunkTime = process.hrtime(startTime);
        var chunkGranule = chunkTime[0] * 48000 + ~~(chunkTime[1] / 20833.333);

        if (chunk.length > 4 && chunk[0] === 0xBE && chunk[1] === 0xDE) {
            // There's an RTP header extension here. Strip it.
            var rtpHLen = chunk.readUInt16BE(2);
            var off = 4;

            for (var rhs = 0; rhs < rtpHLen && off < chunk.length; rhs++) {
                var subLen = (chunk[off]&0xF)+2;
                off += subLen;
            }
            while (off < chunk.length && chunk[off] === 0)
                off++;
            if (off >= chunk.length)
                off = chunk.length;

            chunk = chunk.slice(off);
        }

        write(oggStream, chunkGranule, streamNo, packetNo, chunk);
    }

    // And receiver for the actual data
    function onReceive(chunk, userId) {
        /* Note: We don't use the timestamp because it's different per speaker,
         * and different speakers may have uncoordinated clocks. We stick to
         * only our own, trusted clock. In the future, it may be worthwhile to
         * use a little bit of both. */
        chunk = Buffer.from(chunk);
        var userTrackNo, packetNo;
        if (!(userId in userTrackNos)) {
            userTrackNo = trackNo++;
            userTrackNos[userId] = userTrackNo;
            packetNo = 2;
            userPacketNos[userId] = 3;

            // Put a valid Opus header at the beginning
            try {
                write(recOggHStream[0], 0, userTrackNo, 0, opusHeader[0], ogg.BOS);
                write(recOggHStream[1], 0, userTrackNo, 1, opusHeader[1]);
            } catch (ex) {}
        } else {
            userTrackNo = userTrackNos[userId];
            packetNo = userPacketNos[userId]++;
        }

        try {
            encodeChunk(recOggStream, userTrackNo, packetNo, chunk);
        } catch (ex) {
            console.error(ex);
        }
    }

    receiver.on("data", onReceive);

    // When we're disconnected from the channel...
    function onDisconnect() {
        if (!rec.disconnected) {
            // Not an intentional disconnect
            try {
                log("Unexpected disconnect from " + nameId(connection.channel) + "@" + nameId(connection.channel.guild) + " with ID " + id);
            } catch (ex) {}
            try {
                sReply(true, "I've been unexpectedly disconnected! If you want me to stop recording, please command me to with :craig:, stop.");
            } catch (ex) {}
            rec.disconnected = true;
        }

        // Log it
        try {
            log("Finished recording " + nameId(connection.channel) + "@" + nameId(connection.channel.guild) + " with ID " + id);
        } catch (ex) {}
        recordingEvents.emit("stop", rec);

        // Close the output files
        recOggHStream[0].end();
        recOggHStream[1].end();
        recOggStream.end();

        // Delete our leave timeout
        clearTimeout(partTimeout);
        clearInterval(useInterval);

        // Delete the voice connection (working around an Eris bug)
        try {
            rec.chosenClient.voiceConnections.delete(guild.id);
        } catch (ex) {}

        // And callback
        rec.close();
    }
    connection.on("disconnect", onDisconnect);
    connection.on("error", onDisconnect);
}

// Our command regex changes to match our user ID
var craigCommand = /^(:craig:|<:craig:[0-9]*>)[, ]*([^ ]*) ?(.*)$/;
client.on("ready", () => {
    log("Logged in as " + client.user.username);
    craigCommand = new RegExp("^(:craig:|<:craig:[0-9]*>|<@!?" + client.user.id + ">)[, ]*([^ ]*) ?(.*)$");
    if ("url" in config)
        client.editStatus("online", {name: config.url, url: config.url});
});

// Only admins and those with the Craig role are authorized to use Craig
function userIsAuthorized(member) {
    if (!member) return false;

    // Guild owners are always allowed
    if (member.permission.has("manageGuild"))
        return true;

    // Otherwise, they must be a member of the right role
    var guild = member.guild;
    if (!guild) return false;
    var roles = guild.roles;
    if (member.roles.find((role) => { return roles.get(role).name.toLowerCase() === "craig"; }))
        return true;

    // Not for you!
    return false;
}

// Graceful restart
function gracefulRestart() {
    if (process.channel) {
        // Get the list of active recordings
        var nar = {};
        for (var gid in activeRecordings) {
            var g = activeRecordings[gid];
            var ng = nar[gid] = {};
            for (var cid in g) {
                var c = g[cid];
                var size = 1;
                try {
                    size = c.connection.channel.members.size;
                } catch (ex) {}
                var nc = ng[cid] = {
                    id: c.id,
                    accessKey: c.accessKey,
                    size: size
                };
            }
        }

        // Let the runner spawn a new Craig
        process.send({"t": "gracefulRestart", "activeRecordings": nar});

        // And then exit when we're done
        function maybeQuit(rec) {
            for (var gid in activeRecordings) {
                var g = activeRecordings[gid];
                for (var cid in g) {
                    var c = g[cid];
                    if (c !== rec && c.connection)
                        return;
                }
            }

            // No recordings left, we're done
            setTimeout(() => {
                process.exit(0);
            }, 30000);
        }
        maybeQuit();
        recordingEvents.on("stop", maybeQuit);

    } else {
        // Start a new craig
        var ccp = cp.spawn(
            process.argv[0], ["craig.js"],
            {"stdio": "inherit", "detached": true});
        ccp.on("exit", (code) => {
            process.exit(code ? code : 1);
        });

    }

    // Stop responding to input
    dead = true;
}

// Memory leaks (yay) force us to gracefully restart every so often
var uptimeTimeout = setTimeout(() => { if (!dead) gracefulRestart(); }, 24*60*60*1000);

// Special commands from the owner
function ownerCommand(msg, cmd) {
    if (dead)
        return;

    var op = cmd[2].toLowerCase();

    try {
        log("Owner command: " + nameId(msg.author) + ": " + msg.content);
    } catch (ex) {}

    if (op === "graceful-restart") {
        reply(msg, false, cmd[1], "Restarting!");
        gracefulRestart();

    } else if (op === "eval") {
        var ex, res, ret;

        function stringify(x) {
            var r = "(unprintable)";
            try {
                r = JSON.stringify(x);
                if (typeof r !== "string")
                    throw new Exception();
            } catch (ex) {
                try {
                    r = x+"";
                } catch (ex) {}
            }
            return r;
        }

        function quote(x) {
            return "```" + stringify(x).replace("```", "` ` `") + "```";
        }

        res = ex = undefined;
        try {
            res = eval(cmd[3]);
        } catch (ex2) {
            ex = ex2;
        }

        ret = "";
        if (ex) {
            ex = ex+"";
            ret += "Exception: " + quote(ex) + "\n";
        }
        ret += "Result: " + quote(res);

        reply(msg, true, null, "", ret);

    } else {
        reply(msg, false, cmd[1], "Huh?");

    }
}

var commands = {};

// Our message receiver and command handler
function onMessage(msg) {
    // We don't care if it's not a command
    var cmd = msg.content.match(craigCommand);
    if (cmd === null) return;

    // Is this from our glorious leader?
    if (msg.channel.type === DM_CHANNEL && msg.author.id === config.owner) {
        ownerCommand(msg, cmd);
        return;
    }

    // Ignore it if it's from an unauthorized user
    if (!userIsAuthorized(msg.member)) return;

    // Log it
    try {
        log("Command: " + nameId(msg.member) + "@" + nameId(msg.channel) + "@" + nameId(msg.channel.guild) + ": " + msg.content);
    } catch (ex) {}

    // Keep this guild alive
    try {
        guildRefresh(msg.channel.guild);
    } catch (ex) {}

    var op = cmd[2].toLowerCase();

    var fun = commands[op];
    if (!fun)
        return;

    fun(msg, cmd);
}
client.on("messageCreate", onMessage);

// Find a channel matching the given name
function findChannel(msg, guild, cname) {
    var channel = null;

    guild.channels.find((schannel) => {
        if (schannel.type !== VOICE_CHANNEL)
            return false;

        if (schannel.name.toLowerCase() === cname ||
            (cname === "" && msg.member.voiceState.channelID === schannel.id)) {
            channel = schannel;
            return true;

        } else if (channel === null && schannel.name.toLowerCase().startsWith(cname)) {
            channel = schannel;

        }

        return false;
    });

    return channel;
}

// Join a voice channel, working around discord.js' knot of insane bugs
function safeJoin(channel, err) {
    var guild = channel.guild;
    var insaneInterval;

    function catchConnection() {
        if (guild.voiceConnection) {
            guild.voiceConnection.on("error", (ex) => {
                // Work around the hellscape of discord.js bugs
                try {
                    guild.client.voice.connections.delete(guild.id);
                } catch (noex) {}
                if (err)
                    err(ex);
            });
            clearInterval(insaneInterval);
        }
    }

    var ret = channel.join();
    var insaneInterval = setInterval(catchConnection, 200);

    return ret;
}

// Start recording
commands["join"] = commands["record"] = commands["rec"] = function(msg, cmd) {
    var guild = msg.channel.guild;
    if (!guild)
        return;
    var cname = cmd[3].toLowerCase();
    var channel = null;

    if (dead) {
        // Not our job
        return;
    }

    channel = findChannel(msg, guild, cname);

    if (channel !== null) {
        var guildId = guild.id;
        var channelId = channel.id;
        if (!(guildId in activeRecordings))
            activeRecordings[guildId] = {};

        // Choose the right client
        var takenClients = {};
        var chosenClient = null;
        var chosenClientNum = -1;
        for (var oChannelId in activeRecordings[guildId]) {
            var recording = activeRecordings[guildId][oChannelId];
            takenClients[recording.clientNum] = true;
        }
        for (var ci = 0; ci < clients.length; ci++) {
            if (takenClients[ci]) continue;
            chosenClient = clients[ci];
            chosenClientNum = ci;
            break;
        }

        // Translate the guild and channel to the secondary client
        if (chosenClient && chosenClient !== client) {
            guild = chosenClient.guilds.get(guildId);
            if (guild)
                channel = guild.channels.get(channelId);
        }

        // FIXME: Make the joinable check work with Eris
        var joinable = true;

        // Choose the right action
        if (channelId in activeRecordings[guildId]) {
            var rec = activeRecordings[guildId][channelId];
            reply(msg, true, cmd[1],
                    "I'm already recording that channel: " + config.dlUrl + "?id=" +
                    rec.id + "&key=" + rec.accessKey);

        } else if (!chosenClient) {
            reply(msg, false, cmd[1],
                    "Sorry, but I can't record any more channels on this server! Please ask me to leave a channel I'm currently in first with “:craig:, leave <channel>”, or ask me to leave all channels on this server with “:craig:, stop”");

        } else if (!guild) {
            reply(msg, false, cmd[1],
                    "In Discord, one bot can only record one channel. If you want another channel recorded, you'll have to invite my brother: " + config.secondary[chosenClientNum-1].invite);

        } else if (!channel) {
            reply(msg, false, cmd[1],
                    "My brother can't see that channel. Make sure his permissions are correct.");

        } else if (!joinable) {
            reply(msg, false, cmd[1], "I don't have permission to join that channel!");

        } else {
            // Figure out the recording features for this user
            var f = features(msg.author.id);

            // Make a random ID for it
            var id;
            do {
                id = ~~(Math.random() * 1000000000);
            } while (accessSyncer("rec/" + id + ".ogg.key"));
            var recFileBase = "rec/" + id + ".ogg";

            // Make an access key for it
            var accessKey = ~~(Math.random() * 1000000000);
            fs.writeFileSync(recFileBase + ".key", ""+accessKey, "utf8");

            // Make a deletion key for it
            var deleteKey = ~~(Math.random() * 1000000000);
            fs.writeFileSync(recFileBase + ".delete", ""+deleteKey, "utf8");

            // If the user has features, mark them down
            if (f !== defaultFeatures)
                fs.writeFileSync(recFileBase + ".features", JSON.stringify(f), "utf8");

            // Make sure they get destroyed
            var atcp = cp.spawn("at", ["now + " + f.limits.download + " hours"],
                    {"stdio": ["pipe", 1, 2]});
            atcp.stdin.write("rm -f " + recFileBase + ".header1 " +
                    recFileBase + ".header2 " + recFileBase + ".data " +
                    recFileBase + ".key " + recFileBase + ".delete " +
                    recFileBase + ".features\n");
            atcp.stdin.end();

            // We have a nick per the specific client
            var reNick = config.nick;
            if (chosenClient !== client)
                reNick = config.secondary[chosenClientNum-1].nick;

            var closed = false;
            function close() {
                if (closed)
                    return;
                closed = true;

                // Now get rid of it
                delete activeRecordings[guildId][channelId];
                if (Object.keys(activeRecordings[guildId]).length === 0) {
                    delete activeRecordings[guildId];
                }

                // Rename the bot in this guild
                try {
                    guild.editNickname(reNick).catch(() => {});
                } catch (ex) {}

                // Try to reset our voice connection nonsense by joining a different channel
                var diffChannel = channel;
                guild.channels.some((maybeChannel) => {
                    if (maybeChannel === channel)
                        return false;

                    var joinable = false;
                    try {
                        joinable = maybeChannel.joinable;
                    } catch (ex) {}
                    if (!joinable)
                        return false;

                    diffChannel = maybeChannel;
                    return true;
                });
                function leave() {
                    setTimeout(()=>{
                        try {
                            diffChannel.leave();
                        } catch (ex) {}
                    }, 1000);
                }
                safeJoin(diffChannel, leave).then(leave).catch(leave);
            }

            var rec = {
                guild: guild,
                connection: null,
                id: id,
                accessKey: accessKey,
                client: chosenClient,
                clientNum: chosenClientNum,
                limits: f.limits,
                nick: reNick,
                disconnected: false,
                close: close
            };
            activeRecordings[guildId][channelId] = rec;

            // If we have voice channel issue, do our best to rectify them
            function onError(ex) {
                reply(msg, false, cmd[1], "Failed to join! " + ex);
                close();
            }

            // Join the channel
            safeJoin(channel, onError).then((connection) => {
                // Tell them
                reply(msg, true, cmd[1],
                    "Recording! I will record up to " + f.limits.record +
                    " hours. Recordings are deleted automatically after " + f.limits.download +
                    " hours from the start of recording. The audio can be downloaded even while I'm still recording.\n\n" +
                    "Download link: " + config.dlUrl + "?id=" + id + "&key=" + accessKey,
                    "To delete: " + config.dlUrl + "?id=" + id + "&key=" + accessKey + "&delete=" + deleteKey + "\n.");

                rec.connection = connection;

                session(msg, cmd[1], rec);
            }).catch(onError);
        }

    } else if (!dead) {
        reply(msg, false, cmd[1], "What channel?");

    }

}

// Stop recording
commands["leave"] = commands["part"] = function(msg, cmd) {
    var guild = msg.channel.guild;
    if (!guild)
        return;
    var cname = cmd[3].toLowerCase();

    var channel = findChannel(msg, guild, cname);

    if (channel !== null) {
        var guildId = guild.id;
        var channelId = channel.id;
        if (!(guildId in activeRecordings) ||
            !(channelId in activeRecordings[guildId])) {
            /* Maybe we can just ignore the channel name and leave whatever
             * channel we're in? */
            if (cname === "" && guild.voiceConnection) {
                channel = guild.voiceConnection.channel;
                channelId = channel.id;
            }
        }
        if (guildId in activeRecordings &&
            channelId in activeRecordings[guildId]) {
            try {
                var rec = activeRecordings[guildId][channelId];
                if (rec.connection) {
                    rec.disconnected = true;
                    rec.connection.disconnect();
                }
            } catch (ex) {}

        } else if (!dead) {
            reply(msg, false, cmd[1], "But I'm not recording that channel!");
        }

    } else if (!dead) {
        reply(msg, false, cmd[1], "What channel?");

    }

}

// Stop all recordings
commands["stop"] = function(msg, cmd) {
    var guild = msg.channel.guild;
    if (!guild)
        return;
    var guildId = guild.id;
    if (guildId in activeRecordings) {
        for (var channelId in activeRecordings[guildId]) {
            try {
                var rec = activeRecordings[guildId][channelId];
                if (rec.connection) {
                    rec.disconnected = true;
                    rec.connection.disconnect();
                }
            } catch (ex) {}
        }
    } else if (!dead) {
        reply(msg, false, cmd[1], "But I haven't started!");
    }

}

// Tell the user their features
commands["features"] = function(msg, cmd) {
    if (dead) return;

    var f = features(msg.author.id);
    
    var ret = "\n";
    if (f === defaultFeatures)
        ret += "Default features:";
    else
        ret += "For you:";
    ret += "\nRecording time limit: " + f.limits.record + " hours" +
           "\nDownload time limit: " + f.limits.download + " hours";

    if (f.mix)
        ret += "\nYou may download auto-leveled mixed audio.";
    if (f.mp3)
        ret += "\nYou may download MP3.";

    reply(msg, false, false, ret);
}

// And finally, help commands
commands["help"] = commands["commands"] = commands["hello"] = commands["info"] = function(msg, cmd) {
    if (dead) return;
    reply(msg, false, cmd[1],
        "Hello! I'm Craig! I'm a multi-track voice channel recorder. For more information, see " + config.longUrl + " ");
}

// Checks for catastrophic recording errors
clients.forEach((client) => {
    client.on("voiceChannelSwitch", (member, to, from) => {
        try {
            if (member.id === client.user.id) {
                var guildId = member.guild.id;
                var channelId = from.id;
                if (guildId in activeRecordings &&
                    channelId in activeRecordings[guildId] &&
                    from !== to) {
                    // We do not tolerate being moved
                    log("Terminating recording: Moved to a different channel.");
                    activeRecordings[guildId][channelId].connection.disconnect();
                }
            }
        } catch (err) {}
    });

    client.on("guildUpdate", (to, from) => {
        try {
            if (to.id in activeRecordings && from.region !== to.region) {
                // The server has moved regions. This breaks recording.
                log("Terminating recording: Moved to a different voice region.");
                var g = activeRecordings[to.id];
                for (var cid in g) {
                    var c = g[cid];
                    if (c.client === client)
                        c.connection.disconnect();
                }
            }
        } catch (err) {}
    });

    client.on("guildMemberUpdate", (guild, to, from) => {
        try {
            if (to.id === client.user.id &&
                from.nick !== to.nick &&
                guild.id in activeRecordings &&
                to.nick.indexOf("[RECORDING]") === -1) {
                // They attempted to hide the fact that Craig is recording. Not acceptable.
                log("Terminating recording: Nick changed wrongly.");
                var g = activeRecordings[guild.id];
                for (var cid in g) {
                    var c = g[cid];
                    if (c.client === client)
                        c.connection.disconnect();
                }
            }
        } catch (err) {}
    });
});

/***************************************************************
 * FEATURES BELOW THIS LINE ARE CONVENIENCE/UI FUNCTIONALITY
 **************************************************************/

// Keep track of "important" servers
var importantServers = {};
(function() {
    for (var ii = 0; ii < config.importantServers.length; ii++)
        importantServers[config.importantServers[ii]] = true;
})();

// Check/report our guild membership status every hour
var lastServerCount = 0;
setInterval(() => {
    var client;

    if (dead)
        return;

    for (var ci = 0; ci < clients.length; ci++) {
        client = clients[ci];
        client.guilds.forEach((guild) => {
            if (!(guild.id in guildMembershipStatus)) {
                guildRefresh(guild);
                return;
            }

            if (guildMembershipStatus[guild.id] + config.guildMembershipTimeout < (new Date().getTime())) {
                if (guild.id in importantServers) {
                    guildRefresh(guild);
                    return;
                }

                // Time's up!
                for (var sci = 0; sci < clients.length; sci++) {
                    var g = clients[sci].guilds.get(guild.id);
                    if (g)
                        g.leave().catch(()=>{});
                }

                var step = {"k": guild.id};
                delete guildMembershipStatus[guild.id];
                guildMembershipStatusF.write("," + JSON.stringify(step) + "\n");
            }

            return;
        });
    }

    if (config.discordbotstoken) {
        // Report to discordbots.org
        client = clients[0];
        try {
            var curServerCount = client.guilds.size;
            if (lastServerCount === curServerCount)
                return;
            lastServerCount = curServerCount;
            var postData = JSON.stringify({
                server_count: curServerCount
            });
            var req = https.request({
                hostname: "discordbots.org",
                path: "/api/bots/" + client.user.id + "/stats",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": postData.length,
                    "Authorization": config.discordbotstoken
                }
            }, () => {});
            req.write(postData);
            req.end();
        } catch(ex) {}
    }
}, 3600000);

// Use a server topic to show stats
if (config.stats) {
    (function(){
        var channel = null;
        
        client.on("ready", ()=>{
            try {
                channel = client.guilds.get(config.stats.guild).channels.get(config.stats.channel);
            } catch (ex) {}
        });

        var users = -1;
        var channels = -1;
        function updateTopic(stoppedRec) {
            if (dead)
                return;

            try {
                var newUsers = 0;
                var newChannels = 0;

                for (var gid in activeRecordings) {
                    var g = activeRecordings[gid];
                    for (var cid in g) {
                        var rec = g[cid];
                        if (rec === stoppedRec)
                            continue;
                        if (rec.connection) {
                            try {
                                newUsers += rec.connection.channel.members.size - 1;
                                newChannels++;
                            } catch (ex) {}
                        }
                    }
                }

                var topic = config.stats.topic;
                if (newChannels)
                    topic += " Currently recording " + newUsers + " users in " + newChannels + " voice channels.";
                if (users != newUsers || channels != newChannels) {
                    channel.edit({topic:topic}).catch(()=>{});
                    users = newUsers;
                    channels = newChannels;
                }
                return topic;
            } catch (ex) {
                return ex;
            }
        }
        recordingEvents.on("start", ()=>{updateTopic();});
        recordingEvents.on("stop", updateTopic);

        // And a command to get the full stats
        var statsCp = null;
        commands["stats"] = function(msg, cmd) {
            if (dead)
                return;

            if (!msg.channel.guild || msg.channel.guild.id !== config.stats.guild || statsCp)
                return;

            var statsOut = "";
            statsCp = cp.fork("./stats.js", [config.log], {
                stdio: ["ignore", "pipe", process.stderr, "ipc"]
            });
            statsCp.on("exit", ()=>{
                statsCp = null;
            });
            statsCp.stdout.on("data", (chunk) => {
                statsOut += chunk.toString("utf8");
            });
            statsCp.stdout.on("end", () => {
                msg.channel.createMessage(
                    msg.author.mention + ", \n" +
                    statsOut).catch(()=>{});
            });
        }
    })();
}

// Use server roles to give rewards
if (config.rewards) (function() {
    function resolveRewards(member) {
        var rr = config.rewards.roles;
        var mrewards = {};

        member.roles.forEach((role) => {
            var rn = role.name.toLowerCase();
            if (rn in rr) {
                var roler = rr[rn];
                for (var rid in roler) {
                    if (rid !== "limits") mrewards[rid] = roler[rid];
                }
                if (roler.limits) {
                    if (!mrewards.limits) mrewards.limits = {record: config.limits.record, download: config.limits.download};
                    if (roler.limits.record > mrewards.limits.record)
                        mrewards.limits.record = roler.limits.record;
                    if (roler.limits.download > mrewards.limits.download)
                        mrewards.limits.download = roler.limits.download;
                }
            }
        });

        if (Object.keys(mrewards).length)
            rewards[member.id] = mrewards;
        else
            delete rewards[member.id];
    }

    // Get our initial rewards on connection
    client.on("ready", () => {
        var rr = config.rewards.roles;
        var guild = client.guilds.get(config.rewards.guild);
        if (!guild) return;
        guild.fetchMembers().then((guild) => {
            guild.roles.forEach((role) => {
                var rn = role.name.toLowerCase();
                if (rn in rr)
                    role.members.forEach(resolveRewards);
            });
        });
    });

    // Reresolve a member when their roles change
    client.on("guildMemberUpdate", (from, to) => {
        if (to.guild.id !== config.rewards.guild) return;
        if (from.roles === to.roles) return;
        resolveRewards(to);
    });
})();
