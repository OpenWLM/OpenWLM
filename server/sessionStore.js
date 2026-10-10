export const getUserRoom = (userId) => `user:${userId}`;

export const userSockets = new Map();     // userId (number) -> Set<socketId>
export const socketToUser = new Map();    // socketId -> userId (number)
export const onlineUsers = new Map();     // Rétrocompatibilité : userId -> socketId (dernier connu)

export const isUserOnline = (userId) => {
  const sockets = userSockets.get(Number(userId));
  return Boolean(sockets && sockets.size > 0);
};

export const addUserSocket = (userId, socketId) => {
  const uId = Number(userId);
  if (!userSockets.has(uId)) {
    userSockets.set(uId, new Set());
  }
  userSockets.get(uId).add(socketId);
  socketToUser.set(socketId, uId);
  onlineUsers.set(uId, socketId);
};

export const removeUserSocket = (socketId) => {
  const uId = socketToUser.get(socketId);
  if (uId === undefined) return null;
  socketToUser.delete(socketId);

  const sockets = userSockets.get(uId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      userSockets.delete(uId);
      onlineUsers.delete(uId);
      return { userId: uId, wasLastSocket: true };
    } else {
      const remainingSocket = sockets.values().next().value;
      onlineUsers.set(uId, remainingSocket);
    }
  }
  return { userId: uId, wasLastSocket: false };
};
