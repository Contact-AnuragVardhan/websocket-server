const logger = require('./logger');

function setupAudioEvents(io, socket, pubClient) {
    socket.on('audio-create-room', async (data) => {
        const { roomId, userId } = data;
        logger.info("In Audio Create room ", roomId, " for userId ", userId);
        storeUserInfoinSocket(socket, userId, null);
        await audioCreateRoom(io, roomId, socket, pubClient, userId);
    });

    socket.on('audio-join-room', async (data) => {
        const { roomIdToJoin, userId } = data;
        logger.info("In Audio Join room ", roomIdToJoin, " for userId ", userId);
        storeUserInfoinSocket(socket, userId, null);
        await audioJoinRoom(io, roomIdToJoin, socket, pubClient, userId);
    });

    socket.on('audio-send-offer', (offer, roomId, targetId, userId) => {
        logger.info("In Audio offer for room ", roomId, " from userId ", userId, " from targetId ", targetId);
        storeUserInfoinSocket(socket, userId, null);
        // pass userId so receiving client can filter
        socket.to(targetId).emit('audio-offer', offer, socket.id, userId);
    });

    socket.on('audio-send-answer', (answer, roomId, targetId, userId) => {
        logger.info("In Audio answer for room ", roomId, " from userId ", userId);
        socket.to(targetId).emit('audio-answer', answer, socket.id, userId);
    });

    socket.on('audio-send-ice-candidate', (candidate, roomId, targetId, userId) => {
        logger.info("In Audio ice-candidate for room ", roomId, " from userId ", userId);
        socket.to(targetId).emit('audio-ice-candidate', candidate, socket.id, userId);
    });

    socket.on('audio-leave-room', async (roomId) => {
        await audioLeaveRoom(io, pubClient, roomId, socket);
    });

    socket.on('leave-all-audio-rooms', async () => {
        await audioLeaveAllRooms(io, pubClient, socket);
    });

    //for raw pcm
    socket.on('audio-raw-data-transmitted', (data) => {
        const { frame, userId, roomId } = data;
        logger.info("In audio-raw-data-transmitted for room ", roomId, " from userId ", userId);
        io.to(roomId).emit('audio-raw-data-received', data);
    });
}

async function removeAudioEvents(io, pubClient, socket) {
    await audioLeaveAllRooms(io, pubClient, socket);
}

const storeUserInfoinSocket = (socket, userId, username) => {
    if (socket) {
        if (userId) {
            socket.userId = userId;
        }
        if (username) {
            socket.username = username;
        }
    }
};

const audioCreateRoom = async (io, roomId, socket, pubClient, userId) => {
    const hostId = await pubClient.get(`callRoom:${roomId}:host`);
    if (!hostId) {
        await pubClient.set(`callRoom:${roomId}:host`, socket.id);
        await pubClient.sAdd(`callRoom:${roomId}:participants`, `${socket.id}||${userId}`);
        socket.join(roomId);

        // Get current participants (only host at this time)
        const participantsRaw = await pubClient.sMembers(`callRoom:${roomId}:participants`);
        const participants = participantsRaw.map(str => {
            const [sId, uId] = str.split('||');
            return { socketId: sId, userId: uId };
        });
        // Send participants (excluding the current user)
        socket.emit('audio-participants', participants.filter(p => p.socketId !== socket.id));

        socket.emit('audio-room-created', roomId);
        handleNotificationToAllUserInRoom(io, pubClient, roomId, 'audio-call-notification', {
            roomId: roomId,
            socketId: socket.id,
            userId
        });
        //for vscode
        io.emit('audio-call-notification-all', {
            roomId: roomId,
            socketId: socket.id,
            userId
        });
        await pubClient.sAdd(`socket:${socket.id}:callRooms`, roomId);
    } else {
        // If room already exists, treat this as a join
        await audioJoinRoom(io, roomId, socket, pubClient, userId);
    }
};

const audioJoinRoom = async (io, roomId, socket, pubClient, userId) => {
    const hostId = await pubClient.get(`callRoom:${roomId}:host`);
    if (hostId) {
        await pubClient.sAdd(`callRoom:${roomId}:participants`, `${socket.id}||${userId}`);
        socket.join(roomId);

        // Get all current participants
        const participantsRaw = await pubClient.sMembers(`callRoom:${roomId}:participants`);
        const participants = participantsRaw.map(str => {
            const [sId, uId] = str.split('||');
            return { socketId: sId, userId: uId };
        });

        // Send participant list to the newly joined user, excluding themselves
        socket.emit('audio-participants', participants.filter(p => p.socketId !== socket.id));

        socket.emit('audio-room-joined', {roomId, socketId: socket.id, userId});
        socket.to(roomId).emit('audio-user-joined', {socketId: socket.id, userId});

        handleNotificationToAllUserInRoom(io, pubClient, roomId, 'audio-call-notification', {
            roomId: roomId,
            socketId: socket.id,
            userId
        });
        io.emit('audio-call-notification-all', {
            roomId: roomId,
            socketId: socket.id,
            userId
        });
        await pubClient.sAdd(`socket:${socket.id}:callRooms`, roomId);
    } else {
        socket.emit('error', 'Room not found');
    }
};

const audioLeaveRoom = async (io, pubClient, roomId, socket) => {
    try {
        if (roomId) {
            await pubClient.sRem(`callRoom:${roomId}:participants`, `${socket.id}||${socket.userId}`);

            const size = await pubClient.sCard(`callRoom:${roomId}:participants`);

            io.to(roomId).emit('audio-user-left', { socketId: socket.id, userId: socket.userId });

            if (size <= 1) {
                await pubClient.del(`callRoom:${roomId}:host`);
                await pubClient.del(`callRoom:${roomId}:participants`);
                handleNotificationToAllUserInRoom(io, pubClient, roomId, 'audio-call-disconnected', {
                    roomId: roomId,
                    socketId: socket.id
                });
                //for VSCode
                io.emit('audio-call-disconnected-all', {
                    roomId: roomId,
                    socketId: socket.id
                });
            }

            await pubClient.sRem(`socket:${socket.id}:callRooms`, roomId);

            socket.leave(roomId);

            // Optionally, send a confirmation to the client
            socket.emit('audio-left-room', roomId);

            console.log(`Socket ${socket.id} left room ${roomId}`);
        }

    } catch (error) {
        console.error(`Error leaving room ${roomId}:`, error);
        socket.emit('error', { message: `Failed to leave room ${roomId}`, error });
    }
};

const audioLeaveAllRooms = async (io, pubClient, socket) => {
    const userCallRooms = await pubClient.sMembers(`socket:${socket.id}:callRooms`);
    for (const callRoomId of userCallRooms) {
        await pubClient.sRem(`callRoom:${callRoomId}:participants`, socket.id);
        const size = await pubClient.sCard(`callRoom:${callRoomId}:participants`);
        io.to(callRoomId).emit('audio-user-left', socket.id);
        if (size === 0) {
            // clean up the empty room
            await pubClient.del(`callRoom:${callRoomId}:host`);
            await pubClient.del(`callRoom:${callRoomId}:participants`);
            handleNotificationToAllUserInRoom(io, pubClient, callRoomId, 'audio-call-disconnected', {
                roomId: callRoomId,
                socketId: socket.id
            });
        }
    }
    await pubClient.del(`socket:${socket.id}:callRooms`);
};

const handleNotificationToAllUserInRoom = (io, pubClient, roomId, notificationType, notificationParams) => {
    pubClient.sMembers(`room:${roomId}:users`)
        .then(userIds => {
            const userPromises = userIds.map(uId => {
                return pubClient.sMembers(`userId:${uId}:sockets`)
                    .then(userSocketIds => {
                        if (userSocketIds && userSocketIds.length > 0) {
                            userSocketIds.forEach(userSocketId => {
                                io.to(userSocketId).emit(notificationType, { ...notificationParams, user: uId });
                            });
                        }
                    });
            });
            return Promise.all(userPromises);
        })
        .catch(err => {
            console.error("Error handling notifications:", err);
        });
};

module.exports = {
    setupAudioEvents,
    removeAudioEvents,
    audioCreateRoom,
    audioJoinRoom,
    audioLeaveRoom,
    audioLeaveAllRooms,
};