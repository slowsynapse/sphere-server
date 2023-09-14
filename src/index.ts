import fs from "fs";
import GameSession, { SessionTerminationArgs } from "./network/gamesession";
import axios from "axios";
import Card from "./game/card";
import admin from "firebase-admin";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import { Server, Socket } from "socket.io";

import express from "express";
import cors from "cors";
import Bugsnag from "@bugsnag/js";
Bugsnag.start({ apiKey: "58948bf7047baa1e478933a5b57cb36a" });

dotenv.config();

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(fs.readFileSync("./keys/serviceAccountKey.json").toString())
  ),
  databaseURL: "https://sphere-card-config.firebaseio.com",
  storageBucket: "gs://sphere-card-config.appspot.com",
});

var openSessions: Map<string, GameSession> = new Map<string, GameSession>();

var ref = admin.database().ref("/config");
var data;
ref.on("value", function (snapshot) {
  data = snapshot.val();

  if (Card.data == null) {
    //this just distributes connections to session objects
    server.on("connection", onSocketConnect);
  }

  Card.data = data;

  console.log("config loaded");
});

async function onSocketConnect(socket) {
  console.log("incoming connection..", JSON.stringify(socket.handshake?.query));

  if (!socket.handshake) return; //todo log it?

  let id = socket.handshake.query.id?.toString();

  if (socket.handshake.query.bot) {
    await startGameWithBot(id, socket.handshake.query.bot, socket);
    return;
  }

  var matchId = socket.handshake.query.match?.toString() || null;

  if (
    !id ||
    !socket.handshake.query.token ||
    (socket.handshake.query.token != "debug" &&
      userTokens[id] != socket.handshake.query.token)
  ) {
    console.log("token mismatch");
    joinSession(null, matchId, socket);
    return;
  }

  joinSession(id, matchId, socket);
}

async function startGameWithBot(
  playerId: string,
  botId: string,
  socket: Socket
) {
  var matchId = playerId + ":" + botId;
  const gameType = socket.handshake.query.game_type
  const sessionWithBot = new GameSession(onSessionTerminated, matchId);
  const botData = (
    await axios.get(
      `http://battlehub-service:5000/api/v1/bots/${playerId}/${botId}`
    )
  ).data;
  sessionWithBot.addBot(botData, botId);
  openSessions.set(matchId, sessionWithBot);
  joinSession(playerId, matchId, socket);
}

async function joinSession(id: string, matchId: string, socket: Socket) {
  var resp = await axios.get(
    `http://battlehub-service:5000/api/v1/users/${id}`
  );
  var playerData = resp.data;

  let gameSession = openSessions.get(matchId);

  if (!gameSession || gameSession.ended) {
    gameSession = new GameSession(onSessionTerminated, matchId);
    openSessions.set(matchId, gameSession);
  }

  gameSession.registerPacketLogger(socket);
  gameSession.join(socket, playerData);

  socket.on("dump_packets", () => {
    var session = openSessions.get(matchId);

    //prevent spamming
    socket.removeAllListeners("dump_packets");
    const content = session.getPacketLogs();
    if (content == null || content.length === 0) {
      return; // avoid creating empty dump files
    }
    const now = new Date();
    const filePath = `dumps/${now.getUTCFullYear()}/${now.getUTCMonth()}/${now.getUTCDate()}/${matchId}/${id}-${now.getTime()}.txt`;
    admin
      .storage()
      .bucket()
      .file(filePath)
      .save(content, {
        gzip: true,
        metadata: {
          metadata: { firebaseStorageDownloadTokens: uuidv4() },
        },
        contentType: "text/plain",
      })
      .then(() => {
        session.clearPacketLogs(); // clear logs that have already been dumped (?)
      })
      .catch((error) => {
        Bugsnag.notify(
          `Failed to dump packet logs for match ${matchId} requested by user ${id} because: ${error.toString()}`
        );
      });
  });

  socket.on("disconnect", () => {
    var session = openSessions.get(matchId);
    if (!session) return;

    for (var connection of session.connections) {
      if (connection.connected) return;
    }

    socket.removeAllListeners("dump_packets");
    session.clearPacketLogs();
    session.terminate();
  });
}

var httpserver = http.createServer((req, res) => {
  res.writeHead(req.method == "GET" && req.url == "/healthcheck" ? 200 : 404);
  res.end();
});
httpserver.listen(process.env.PORT, () => {
  console.log(`listening to ${process.env.PORT}..`);
});

var server = new Server(httpserver, { cors: { origin: "*" } });

function onSessionTerminated(args: SessionTerminationArgs) {
  var session = openSessions.get(args.matchId);
  if (!session) {
    Bugsnag.notify(new Error("notifyBot no openSession!"), function (event) {
      event.addMetadata("SessionTerminationArgs", args);
      return true;
    });
  }

  axios.post("http://battlehub-service:5000/api/v1/match/end", args, {
    headers: {
      "X-API-KEY": process.env.SPHERE_API_KEY,
    },
  });
  dumpGameSession(session);
}

function dumpGameSession(session: GameSession) {
  console.warn("match ended, deleting session");

  if (!session) return;

  if (session.sessionLog) {
    const file = admin
      .storage()
      .bucket()
      .file(
        `logs/${new Date()
          .toLocaleDateString("en-GB")
          .replace(/\//g, "-")}/[${new Date().getTime()}] ${
          session.matchId
        }.txt`
      );
    file
      .save(openSessions.get(session.matchId).sessionLog, {
        gzip: true,
        metadata: {
          metadata: { firebaseStorageDownloadTokens: uuidv4() },
        },
        contentType: "text/plain",
      })
      .then(() => {
        console.log("log uploaded");
      });
  } else Bugsnag.notify(`Logs missing for ${session.matchId}!`);

  openSessions.delete(session.matchId);
}

var userTokens = {};

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true,
  })
);

app.listen(process.env.TOKEN_PORT, async () => {
  console.log(
    `Listening for incoming token http requests on port ${process.env.TOKEN_PORT}`
  );
});

app.post("/setToken", (req, res) => {
  console.log("setToken: " + req.body);
  if (req.body.id && req.body.token) {
    userTokens[req.body.id] = req.body.token;
    res.end("ok");
  } else {
    res.statusCode = 400;
    res.end("set token failed!");
  }
  res.json({});
});
