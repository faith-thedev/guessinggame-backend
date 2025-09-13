// types/game.ts
export interface Player {
  id: string;
  username: string;
  score: number;
}

export interface GameSession {
  id: string;
  master: string; // player id of the game master
  players: Map<string, Player>;
  status: "waiting" | "in-progress" | "finished";
  question: string | null;
  answer: string | null;
  winner: string | null; // player id of the winner
  timer: NodeJS.Timeout | null;
  attempts: Map<string, number>; // player id -> attempts left
  scores: Map<string, number>; // player id -> total score
}

export interface CreateSessionData {
  username: string;
}

export interface JoinSessionData {
  sessionId: string;
  username: string;
}

export interface StartGameData {
  sessionId: string;
  question: string;
  answer: string;
}

export interface SubmitGuessData {
  sessionId: string;
  guess: string;
}

export interface SocketResponse {
  success: boolean;
  message?: string;
  data?: any;
}
