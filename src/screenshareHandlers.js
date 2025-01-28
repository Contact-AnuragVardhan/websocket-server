// screenshareHandlers.js
const logger = require('./logger');

function setupScreenShareEvents(io, socket, pubClient) {

  socket.on('screenshare-create-room', async (data) => {
    const { roomId, userId } = data;
    logger.info(`[screenshare] Creating screen share room: ${roomId}, userId: ${userId}`);
    await screenshareCreateRoom(io, roomId, socket, pubClient, userId);
  });

  socket.on('screenshare-join-room', async (data) => {
    const { roomIdToJoin, userId } = data;
    logger.info(`[screenshare] Joining screen share room: ${roomIdToJoin}, userId: ${userId}`);
    await screenshareJoinRoom(io, roomIdToJoin, socket, pubClient, userId);
  });

  socket.on('screenshare-send-offer', (offer, roomId, targetSocketId, userId, targetUserId) => {
    logger.info(`[screenshare] Offer -> from userId ${userId}, roomId ${roomId} -> to socketId ${targetSocketId} and targetUserId ${targetUserId}`);
    socket.to(targetSocketId).emit('screenshare-offer', offer, socket.id, userId);
  });

  socket.on('screenshare-send-answer', (answer, roomId, targetSocketId, userId) => {
    logger.info(`[screenshare] Answer -> from userId ${userId}, roomId ${roomId} -> to socketId ${targetSocketId}`);
    socket.to(targetSocketId).emit('screenshare-answer', answer, socket.id, userId);
  });

  socket.on('screenshare-send-ice-candidate', (candidate, roomId, targetSocketId, userId) => {
    logger.info(`[screenshare] ICE -> from userId ${userId}, roomId ${roomId} -> to socketId ${targetSocketId}`);
    socket.to(targetSocketId).emit('screenshare-ice-candidate', candidate, socket.id, userId);
  });

  socket.on('screenshare-leave-room', async (roomId) => {
    logger.info(`[screenshare] leave-room -> roomId: ${roomId}, socketId: ${socket.id}`);
    await screenshareLeaveRoom(io, pubClient, roomId, socket);
  });

  socket.on('screenshare-leave-all-rooms', async () => {
    logger.info(`[screenshare] leave-all-rooms -> socketId: ${socket.id}`);
    await screenshareLeaveAllRooms(io, pubClient, socket);
  });

  socket.on('screenshare-stop-sharing', async (roomId) => {
    logger.info(`[screenshare] stop-sharing -> roomId: ${roomId}, socketId: ${socket.id}`);
    await screenshareStopSharing(io, pubClient, roomId, socket);
  });
}

async function removeScreenShareEvents(io, pubClient, socket) {
  await screenshareLeaveAllRooms(io, pubClient, socket);
}

async function screenshareCreateRoom(io, roomId, socket, pubClient, userId) {
  await pubClient.set(`screenshareRoom:${roomId}:sharerUserId`, userId);
  const hostId = await pubClient.get(`screenshareRoom:${roomId}:host`);
  if (!hostId) {
    await pubClient.set(`screenshareRoom:${roomId}:host`, socket.id);
    await pubClient.sAdd(`screenshareRoom:${roomId}:participants`, `${socket.id}||${userId}`);
    socket.join(roomId);

    socket.emit('screenshare-room-created', roomId);

    handleNotificationToAllUserInRoom(
      io,
      pubClient,
      roomId,
      'screenshare-call-notification',
      { roomId, socketId: socket.id, userId }
    );

    await pubClient.sAdd(`socket:${socket.id}:screenshareRooms`, roomId);
    await autoJoinAllChatRoomParticipants(io, pubClient, roomId);
    const participantsRaw = await pubClient.sMembers(`screenshareRoom:${roomId}:participants`);
    const participants = participantsRaw.map((str) => {
      const [sId, uId] = str.split('||');
      return { socketId: sId, userId: uId };
    });
    //socket.emit('screenshare-participants', participants.filter((p) => p.socketId !== socket.id));
  } else {
    await screenshareJoinRoom(io, roomId, socket, pubClient, userId);
    await autoJoinAllChatRoomParticipants(io, pubClient, roomId);
  }
}

async function autoJoinAllChatRoomParticipants(io, pubClient, screenshareRoomId) {
  const mainChatUserIds = await pubClient.sMembers(`room:${screenshareRoomId}:users`);

  for (const participantUserId of mainChatUserIds) {
    const participantSockets = await pubClient.sMembers(`userId:${participantUserId}:sockets`);

    for (const participantSocketId of participantSockets) {
      const participantSocket = io.sockets.sockets.get(participantSocketId);
      if (participantSocket) {
        participantSocket.emit('screenshare-ask-user-to-join-room', {
          roomId: screenshareRoomId,
          socketId: participantSocketId,
          userId: participantUserId,
        });
        // 3) Mark them in the screenshare participants set
        /*await pubClient.sAdd(
          `screenshareRoom:${screenshareRoomId}:participants`,
          `${participantSocketId}||${participantUserId}`
        );
        
        // 4) Force server-side to join the room
        participantSocket.join(screenshareRoomId);

        // 5) Let that socket know they joined
        participantSocket.emit('screenshare-room-joined', {
          roomId: screenshareRoomId,
          socketId: participantSocketId,
          userId: participantUserId,
        });

        // 6) Broadcast to others
        participantSocket.to(screenshareRoomId).emit('screenshare-user-joined', {
          socketId: participantSocketId,
          userId: participantUserId,
        });*/
      }
    }

    //streamline it
    /*const participantsRaw = await pubClient.sMembers(`screenshareRoom:${screenshareRoomId}:participants`);
    const participants = participantsRaw.map((str) => {
      const [sId, uId] = str.split('||');
      return { socketId: sId, userId: uId };
    });

    socket.emit('screenshare-participants', participants.filter((p) => p.socketId !== socket.id));*/
  }
}

async function screenshareJoinRoom(io, roomId, socket, pubClient, userId) {
  const hostId = await pubClient.get(`screenshareRoom:${roomId}:host`);
  if (hostId) {
    await pubClient.sAdd(`screenshareRoom:${roomId}:participants`, `${socket.id}||${userId}`);
    socket.join(roomId);

    const participantsRaw = await pubClient.sMembers(`screenshareRoom:${roomId}:participants`);
    const participants = participantsRaw.map((str) => {
      const [sId, uId] = str.split('||');
      return { socketId: sId, userId: uId };
    });

    const sharerUserId = await pubClient.get(`screenshareRoom:${roomId}:sharerUserId`);
    const sharerUserSocketIds = await pubClient.sMembers(`userId:${sharerUserId}:sockets`);
    const dataToEmit = participants.filter((p) => p.socketId !== socket.id);
    sharerUserSocketIds.forEach((sharerUserSocketId) => {
      io.to(sharerUserSocketId).emit('screenshare-participants', {participantIds: dataToEmit, initiatorUserId: sharerUserId});
    });

    //socket.emit('screenshare-participants', dataToEmit);

    socket.emit('screenshare-room-joined', {
      roomId,
      socketId: socket.id,
      userId,
      initiatorUserId: sharerUserId
    });
    socket.to(roomId).emit('screenshare-user-joined', {
      socketId: socket.id,
      userId,
      initiatorUserId: sharerUserId
    });

    handleNotificationToAllUserInRoom(
      io,
      pubClient,
      roomId,
      'screenshare-call-notification',
      { roomId, socketId: socket.id, userId, initiatorUserId: sharerUserId }
    );

    await pubClient.sAdd(`socket:${socket.id}:screenshareRooms`, roomId);
  } else {
    socket.emit('error', 'Screen share room not found');
  }
}

async function screenshareLeaveRoom(io, pubClient, roomId, socket) {
  try {
    if (roomId) {
      await pubClient.sRem(
        `screenshareRoom:${roomId}:participants`,
        `${socket.id}||${socket.userId}`
      );
      const size = await pubClient.sCard(`screenshareRoom:${roomId}:participants`);

      io.to(roomId).emit('screenshare-user-left', {
        socketId: socket.id,
        userId: socket.userId
      });

      if (size === 0) {
        await pubClient.del(`screenshareRoom:${roomId}:host`);
        await pubClient.del(`screenshareRoom:${roomId}:sharerUserId`);
        await pubClient.del(`screenshareRoom:${roomId}:participants`);
        handleNotificationToAllUserInRoom(
          io,
          pubClient,
          roomId,
          'screenshare-call-disconnected',
          { roomId, socketId: socket.id }
        );
      }
      await pubClient.sRem(`socket:${socket.id}:screenshareRooms`, roomId);
      socket.leave(roomId);
      socket.emit('screenshare-left-room', roomId);
      logger.info(`[screenshare] Socket ${socket.id} left room ${roomId}`);
    }
  } catch (error) {
    logger.error(`[screenshare] Error leaving room ${roomId}:`, error);
    socket.emit('error', { message: `Failed to leave screen share room ${roomId}`, error });
  }
}

async function screenshareLeaveAllRooms(io, pubClient, socket) {
  const userScreenshareRooms = await pubClient.sMembers(`socket:${socket.id}:screenshareRooms`);
  for (const ssRoomId of userScreenshareRooms) {
    await pubClient.sRem(`screenshareRoom:${ssRoomId}:participants`, `${socket.id}||${socket.userId}`);
    const size = await pubClient.sCard(`screenshareRoom:${ssRoomId}:participants`);

    io.to(ssRoomId).emit('screenshare-user-left', { socketId: socket.id, userId: socket.userId });
    if (size === 0) {
      await pubClient.del(`screenshareRoom:${ssRoomId}:host`);
      await pubClient.del(`screenshareRoom:${roomId}:sharerUserId`);
      await pubClient.del(`screenshareRoom:${ssRoomId}:participants`);
      handleNotificationToAllUserInRoom(
        io,
        pubClient,
        ssRoomId,
        'screenshare-call-disconnected',
        { roomId: ssRoomId, socketId: socket.id }
      );
    }
  }
  await pubClient.del(`socket:${socket.id}:screenshareRooms`);
}

async function screenshareStopSharing(io, pubClient, roomId, socket) {
  try {
    const sharerUserId = await pubClient.get(`screenshareRoom:${roomId}:sharerUserId`);

    await handleNotificationToAllUserInRoom(
      io,
      pubClient,
      roomId,
      'screenshare-call-disconnected',
      { roomId, socketId: socket.id, initiatorUserId: sharerUserId }
    );

    const participantEntries = await pubClient.sMembers(`screenshareRoom:${roomId}:participants`);
    for (const entry of participantEntries) {
      const [participantSocketId, participantUserId] = entry.split('||');

      await pubClient.sRem(`screenshareRoom:${roomId}:participants`, entry);

      //watchers know they're removed
      io.to(roomId).emit('screenshare-user-left', {
        socketId: participantSocketId,
        userId: participantUserId
      });

      // forcibly have them leave the socket.io room
      const participantSocket = io.sockets.sockets.get(participantSocketId);
      if (participantSocket) {
        participantSocket.leave(roomId);
        await pubClient.sRem(`socket:${participantSocketId}:screenshareRooms`, roomId);
      }
    }

    await pubClient.del(`screenshareRoom:${roomId}:host`);
    await pubClient.del(`screenshareRoom:${roomId}:sharerUserId`);
    await pubClient.del(`screenshareRoom:${roomId}:participants`);

    logger.info(`[screenshare] screenshareStopSharing completed for room ${roomId}`);
  } catch (error) {
    logger.error(`[screenshare] Error stopping screenshare for room ${roomId}:`, error);
    socket.emit('error', { message: `Failed to stop screenshare for room ${roomId}`, error });
  }
}

async function handleNotificationToAllUserInRoom(io, pubClient, roomId, notificationType, notificationParams) {
  try {
    const userIds = await pubClient.sMembers(`room:${roomId}:users`);

    const userPromises = userIds.map(async (uId) => {
      const userSocketIds = await pubClient.sMembers(`userId:${uId}:sockets`);
      if (userSocketIds && userSocketIds.length > 0) {
        userSocketIds.forEach((userSocketId) => {
          io.to(userSocketId).emit(notificationType, {
            ...notificationParams,
            user: uId
          });
        });
      }
    });

    await Promise.all(userPromises);

  } catch (err) {
    logger.error(`[screenshare] Error handling notifications:`, err);
    throw err;
  }
}

/*function handleNotificationToAllUserInRoom(io, pubClient, roomId, notificationType, notificationParams) {
  return pubClient.sMembers(`room:${roomId}:users`)
    .then((userIds) => {
      const userPromises = userIds.map((uId) => {
        return pubClient.sMembers(`userId:${uId}:sockets`).then((userSocketIds) => {
          if (userSocketIds && userSocketIds.length > 0) {
            userSocketIds.forEach((userSocketId) => {
              io.to(userSocketId).emit(notificationType, {
                ...notificationParams,
                user: uId
              });
            });
          }
        });
      });
      return Promise.all(userPromises);
    })
    .catch((err) => {
      logger.error(`[screenshare] Error handling notifications:`, err);
    });
}*/

module.exports = {
  setupScreenShareEvents,
  removeScreenShareEvents,
  screenshareCreateRoom,
  screenshareJoinRoom,
  screenshareLeaveRoom,
  screenshareLeaveAllRooms,
};
