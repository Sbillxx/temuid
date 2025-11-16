"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { v4 as uuidv4 } from "uuid";

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const router = useRouter();

  const handleCreateRoom = () => {
    const newRoomId = uuidv4();
    router.push(`/room/${newRoomId}`);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      router.push(`/room/${roomId.trim()}`);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-center py-32 px-16 bg-white dark:bg-black">
        <div className="flex flex-col items-center gap-8 text-center w-full">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight text-black dark:text-zinc-50">Video Meeting App</h1>
          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">Create a new room or join an existing one using a room ID.</p>

          <div className="w-full max-w-md space-y-4">
            <button onClick={handleCreateRoom} className="w-full flex h-12 items-center justify-center gap-2 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] font-medium">
              Create New Room
            </button>

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-zinc-300 dark:border-zinc-700"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white dark:bg-black text-zinc-500 dark:text-zinc-400">OR</span>
              </div>
            </div>

            <form onSubmit={handleJoinRoom} className="space-y-4">
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="Enter Room ID"
                className="w-full h-12 px-4 rounded-full border border-solid border-black/8 dark:border-white/[.145] bg-white dark:bg-black text-black dark:text-zinc-50 placeholder:text-zinc-500 dark:placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-foreground transition-colors"
              />
              <button
                type="submit"
                disabled={!roomId.trim()}
                className="w-full flex h-12 items-center justify-center rounded-full border border-solid border-black/8 px-5 transition-colors hover:border-transparent hover:bg-black/4 dark:border-white/[.145] dark:hover:bg-[#1a1a1a] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Join Room
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
