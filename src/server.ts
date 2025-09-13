// server.ts
import express from "express";
import {createServer} from "http";
import {Server, Socket} from "socket.io";
import cors from "cors";
import {v4 as uuidv4} from "uuid";

import {
  GameSession,
  Player,
  CreateSessionData,
  JoinSessionData,
  StartGameData,
  SubmitGuessData,
} from "../src/types";

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// In-memory storage
const gameSessions = new Map<string, GameSession>();
const playerSessions = new Map<string, string>(); // player id -> session id

// Helper functions
function emitToSession(sessionId: string, event: string, data: any): void {
  io.to(sessionId).emit(event, data);
}

function endGame(sessionId: string, winnerId: string | null): void {
  const gameSession = gameSessions.get(sessionId);
  if (!gameSession) return;

  // Clear timer if exists
  if (gameSession.timer) {
    clearInterval(gameSession.timer);
    gameSession.timer = null;
  }

  gameSession.status = "finished";
  gameSession.winner = winnerId;

  if (winnerId) {
    // Update scores
    const currentScore = gameSession.scores.get(winnerId) || 0;
    gameSession.scores.set(winnerId, currentScore + 10);

    // Update player object score
    const winner = gameSession.players.get(winnerId);
    if (winner) {
      winner.score += 10;
    }
  }

  emitToSession(sessionId, "game-ended", {
    winner: winnerId ? gameSession.players.get(winnerId) : null,
    answer: gameSession.answer,
    scores: Array.from(gameSession.players.values()).map((p: any) => ({
      username: p.username,
      score: p.score,
    })),
  });

  // Rotate game master for next round
  const playersArray = Array.from(gameSession.players.keys());
  const currentMasterIndex = playersArray.indexOf(gameSession.master);
  const nextMasterIndex = (currentMasterIndex + 1) % playersArray.length;
  gameSession.master = playersArray[nextMasterIndex] as string;
  gameSession.status = "waiting";
  gameSession.question = null;
  gameSession.answer = null;

  setTimeout(() => {
    emitToSession(sessionId, "new-game-master", {
      master: gameSession.players.get(gameSession.master),
    });
  }, 3000);
}

// Socket.io connection handling
io.on("connection", (socket: Socket) => {
  console.log("User connected:", socket.id);

  // Create a new game session
  socket.on("create-session", (data: CreateSessionData) => {
    const {username} = data;

    if (!username || username.trim() === "") {
      socket.emit("error", {message: "Username is required"});
      return;
    }

    const sessionId = uuidv4().substring(0, 8);

    const gameSession: GameSession = {
      id: sessionId,
      master: socket.id,
      players: new Map(),
      status: "waiting",
      question: null,
      answer: null,
      winner: null,
      timer: null,
      attempts: new Map(),
      scores: new Map(),
    };

    gameSessions.set(sessionId, gameSession);

    // Add creator as first player
    const player: Player = {id: socket.id, username, score: 0};
    gameSession.players.set(socket.id, player);
    playerSessions.set(socket.id, sessionId);

    socket.join(sessionId);
    socket.emit("session-created", {sessionId, player});
  });

  // Join an existing session
  socket.on("join-session", (data: JoinSessionData) => {
    const {sessionId, username} = data;

    if (!username || username.trim() === "") {
      socket.emit("error", {message: "Username is required"});
      return;
    }

    if (!sessionId || sessionId.trim() === "") {
      socket.emit("error", {message: "Session ID is required"});
      return;
    }

    const gameSession = gameSessions.get(sessionId);

    if (!gameSession) {
      socket.emit("error", {message: "Session not found"});
      return;
    }

    if (gameSession.status !== "waiting") {
      socket.emit("error", {message: "Game already in progress"});
      return;
    }

    const player: Player = {id: socket.id, username, score: 0};
    gameSession.players.set(socket.id, player);
    playerSessions.set(socket.id, sessionId);

    socket.join(sessionId);
    socket.emit("joined-session", {sessionId, player});
    emitToSession(sessionId, "player-joined", {
      players: Array.from(gameSession.players.values()),
    });
  });

  // Start the game (only by game master)
  socket.on("start-game", (data: StartGameData) => {
    const {sessionId, question, answer} = data;
    const gameSession = gameSessions.get(sessionId);

    if (!gameSession) {
      socket.emit("error", {message: "Session not found"});
      return;
    }

    if (gameSession.master !== socket.id) {
      socket.emit("error", {message: "Not authorized to start game"});
      return;
    }

    if (gameSession.players.size < 2) {
      socket.emit("error", {message: "Need at least 2 players to start"});
      return;
    }

    if (!question || question.trim() === "") {
      socket.emit("error", {message: "Question is required"});
      return;
    }

    if (!answer || answer.trim() === "") {
      socket.emit("error", {message: "Answer is required"});
      return;
    }

    gameSession.status = "in-progress";
    gameSession.question = question;
    gameSession.answer = answer.toLowerCase().trim();

    // Initialize attempts for all players
    gameSession.attempts = new Map(
      Array.from(gameSession.players.keys()).map((id) => [id, 3])
    );

    // Start timer (60 seconds)
    let timeLeft = 60;
    gameSession.timer = setInterval(() => {
      timeLeft--;
      emitToSession(sessionId, "timer-update", {timeLeft});

      if (timeLeft <= 0) {
        endGame(sessionId, null);
      }
    }, 1000);

    emitToSession(sessionId, "game-started", {
      question,
      timeLeft,
      attempts: 3,
    });
  });

  // Handle player guesses
  socket.on("submit-guess", (data: SubmitGuessData) => {
    const {sessionId, guess} = data;
    const gameSession = gameSessions.get(sessionId);

    if (!gameSession) {
      socket.emit("error", {message: "Session not found"});
      return;
    }

    if (gameSession.status !== "in-progress") {
      socket.emit("error", {message: "Game not in progress"});
      return;
    }

    if (!guess || guess.trim() === "") {
      socket.emit("error", {message: "Guess cannot be empty"});
      return;
    }

    const playerId = socket.id;
    let attemptsLeft = (gameSession.attempts.get(playerId) || 0) - 1;
    gameSession.attempts.set(playerId, attemptsLeft);

    const isCorrect = guess.toLowerCase().trim() === gameSession.answer;

    if (isCorrect) {
      // Player guessed correctly
      endGame(sessionId, playerId);
    } else if (attemptsLeft <= 0) {
      // Player out of attempts
      socket.emit("no-attempts-left");
    } else {
      // Incorrect guess but still has attempts
      socket.emit("incorrect-guess", {attemptsLeft});
    }
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    const sessionId = playerSessions.get(socket.id);
    if (!sessionId) return;

    const gameSession = gameSessions.get(sessionId);
    if (!gameSession) return;

    gameSession.players.delete(socket.id);
    playerSessions.delete(socket.id);

    if (gameSession.players.size === 0) {
      // Remove empty session
      gameSessions.delete(sessionId);
    } else if (gameSession.master === socket.id) {
      // If master left, assign new master
      const newMasterId = Array.from(gameSession.players.keys())[0];
      gameSession.master = newMasterId as string;

      emitToSession(sessionId, "new-game-master", {
        master: gameSession.players.get(newMasterId!),
      });
    }

    emitToSession(sessionId, "player-left", {
      players: Array.from(gameSession.players.values()),
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
