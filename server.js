// server.js (MODIFICADO - LOGIN / REGISTER agregado)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// --- NUEVOS REQUERIMIENTOS PARA AUTH ---
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
// --- FIN: NUEVOS REQUERIMIENTOS ---

const app = express();
const server = http.createServer(app);

// --- CONFIGURACIÓN DE SOCKET.IO Y EXPRESS ---
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// --- MIDDLEWARES NUEVOS ---
app.use(bodyParser.json()); // para parsear JSON en endpoints de login/register
// --- FIN MIDDLEWARES ---

app.use('/socket.io', express.static(path.join(__dirname, 'node_modules/socket.io/client-dist'))); 
app.use(express.static(path.join(__dirname, 'public'))); 
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === CONFIGURACIÓN POSTGRESQL (según datos proporcionados) ===
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'dice_soccer',
    password: 'postgres',
    port: 5432,
});
// ============================================================

// === ENDPOINTS DE AUTENTICACIÓN ===
// Registro: guarda username + password_hash (bcrypt)
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Faltan campos: username y password son requeridos.' });
    }

    try {
        // Validación mínima (puedes extenderla)
        if (typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ success: false, error: 'Datos inválidos.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
        }

        const hash = await bcrypt.hash(password, 10);
        const q = 'INSERT INTO players (username, password_hash) VALUES ($1, $2)';
        await pool.query(q, [username, hash]);

        return res.json({ success: true, message: 'Usuario registrado correctamente.' });
    } catch (err) {
        console.error('Error en /register:', err);
        // Código 23505 = unique_violation en Postgres
        if (err.code === '23505') {
            return res.status(409).json({ success: false, error: 'El nombre de usuario ya existe.' });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
    }
});

// Login: valida username + password (bcrypt compare)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Faltan credenciales.' });
    }

    try {
        const q = 'SELECT id, username, password_hash FROM players WHERE username = $1';
        const result = await pool.query(q, [username]);

        if (result.rows.length === 0) {
            // No existe el usuario
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ success: false, error: 'Usuario o contraseña incorrectos.' });
        }

        // Login correcto. Respondemos con success y el username.
        return res.json({ success: true, username: user.username });
    } catch (err) {
        console.error('Error en /login:', err);
        return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
    }
});
// === FIN ENDPOINTS DE AUTENTICACIÓN ===

const PORT = 3000;
const RULES_MAX_POINTS = 10;
const RULES_MAX_STAT = 7;
const RULES_MAX_PHASES = 1;

// --- ESTRUCTURA DEL JUEGO AUTORITATIVA: MAPA DE SALAS ---
let games = {}; // Almacena el estado de todos los juegos activos, indexados por roomId

// === CONSTANTES PARA ABANDONO ===
const ABANDONMENT_TIMEOUT_MS = 5000; // 5 segundos de gracia para reconexión
let disconnectTimeouts = {}; // Almacena los timeouts, clave: "roomId_role"
// === END: CONSTANTES PARA ABANDONO ===


function initializeGameState() {
    return {
        p1: { D: 0, M: 0, A: 0, score: 0, name: 'Player 1' },
        p2: { D: 0, M: 0, A: 0, score: 0, name: 'Player 2' },
        currentPhase: 0,
        ballArea: 'M',
        attacker: null, 
        defender: null, 
        isSetupComplete: false,
        playerCount: 0,
        gameOver: false,
        p1SocketId: null,
        p2SocketId: null,
        p1Rolled: false, 
        p2Rolled: false,
        lastRoll: { roll1: '?', roll2: '?', total1: 0, total2: 0, details: '' },
        statusMessage: `**Esperando jugadores. Configura tus ${RULES_MAX_POINTS} puntos de táctica.**`,
        p1ReadyForNewGame: false,
        p2ReadyForNewGame: false,
        abandonedBy: null, // 'p1', 'p2', o null. Jugador que abandonó.
    };
}

function getGame(roomId) {
    return games[roomId];
}

function rollD6() {
    return Math.floor(Math.random() * 6) + 1;
}

function resetGame(roomId) {
    const game = getGame(roomId);
    if (!game) return;
    
    // 1. Almacenar los IDs de socket y los nombres
    const oldP1SocketId = game.p1SocketId;
    const oldP2SocketId = game.p2SocketId;
    const oldP1Name = game.p1.name; 
    const oldP2Name = game.p2.name; 
    
    // 2. Reiniciar el estado del juego, limpiando variables como isSetupComplete, scores, etc.
    Object.assign(game, initializeGameState());
    
    // 3. Restaurar los IDs de socket, nombres y conteo de jugadores
    game.p1SocketId = oldP1SocketId; 
    game.p2SocketId = oldP2SocketId;
    game.p1.name = oldP1Name; 
    game.p2.name = oldP2Name; 
    
    game.playerCount = (game.p1SocketId !== null ? 1 : 0) + (game.p2SocketId !== null ? 1 : 0);
    
    game.statusMessage = `**Nueva partida. Configura tus ${RULES_MAX_POINTS} puntos de táctica.**`;
}

function endPhase(roomId) {
    const game = getGame(roomId);
    if (!game) return;
    
    game.currentPhase++;
    game.ballArea = 'M';
    game.attacker = null;
    game.defender = null;

    if (game.currentPhase >= RULES_MAX_PHASES) {
        endGame(roomId);
    }
}

function endGame(roomId) {
    const game = getGame(roomId);
    if (!game) return;
    
    game.gameOver = true;
    let finalMessage = "";

    if (game.p1.score > game.p2.score) {
        finalMessage = `Player 1 WINS! (${game.p1.score} - ${game.p2.score})`;
    } else if (game.p2.score > game.p1.score) {
        finalMessage = `Player 2 WINS! (${game.p2.score} - ${game.p1.score})`;
    } else {
        finalMessage = `It's a DRAW! (${game.p1.score} - ${game.p2.score})`;
    }

    game.statusMessage = `**¡TIEMPO COMPLETO!** El juego ha terminado. ${finalMessage}`;
    io.to(roomId).emit('gameEnd', game.statusMessage);
    io.to(roomId).emit('stateUpdate', game); 
}

/**
 * Filtra las salas que tienen espacio (playerCount < 2) y las emite a todos los clientes.
 */
function broadcastActiveRooms() {
    const activeRooms = Object.keys(games).filter(roomId => games[roomId].playerCount < 2);
    io.emit('activeRoomsList', activeRooms);
}


// === LÓGICA DE ABANDONO ===

function declareWinnerByAbandonment(roomId, abandoningRole) {
    const game = getGame(roomId);
    if (!game || game.gameOver) return;

    const winnerRole = (abandoningRole === 1) ? 2 : 1;
    
    game.gameOver = true;
    game.abandonedBy = `p${abandoningRole}`;
    
    const winnerPlayer = game[`p${winnerRole}`];
    const loserPlayer = game[`p${abandoningRole}`];
    const winnerName = winnerPlayer.name || `Player ${winnerRole}`;
    const loserName = loserPlayer.name || `Player ${abandoningRole}`;

    //if (winnerPlayer.score <= loserPlayer.score) {
        winnerPlayer.score = 5;
        loserPlayer.score = 0;
    //}

    game.statusMessage = `**¡VICTORIA POR ABANDONO!** El jugador ${loserName} ha abandonado el partido. El jugador ${winnerName} gana.`;
    
    io.to(roomId).emit('gameEnd', game.statusMessage);
    io.to(roomId).emit('stateUpdate', game); 
}

function clearAbandonmentTimeout(roomId, playerRole) {
    const timeoutKey = `${roomId}_${playerRole}`;
    if (disconnectTimeouts[timeoutKey]) {
        clearTimeout(disconnectTimeouts[timeoutKey]);
        delete disconnectTimeouts[timeoutKey];
        console.log(`Timeout de abandono para Jugador ${playerRole} en ${roomId} CANCELADO (reconexión).`);
        return true;
    }
    return false;
}

// === END: LÓGICA DE ABANDONO ===

function resolveConfrontation(roomId) {
    const game = getGame(roomId);
    if (!game) return;
    
    const total1 = game.lastRoll.total1;
    const total2 = game.lastRoll.total2;
    let winner = 0;
    
    if (total1 > total2) winner = 1;
    else if (total2 > total1) winner = 2;
    else winner = 0; 
    
    let opponentNum = (winner === 1) ? 2 : 1;
    let attackerName = game[`p${game.attacker}`]?.name || `Jugador ${game.attacker}`;
    let defenderName = game[`p${game.defender}`]?.name || `Jugador ${game.defender}`;


    switch (game.ballArea) {
        case 'M': 
            game.lastRoll.details = "Resultado del enfrentamiento: Mediocampo (M vs M):";
            if (winner !== 0) {
                game.attacker = winner;
                game.defender = opponentNum; 
                game.ballArea = 'A'; 
                game.statusMessage = `**GANADOR: ${game[`p${winner}`].name || `Jugador ${winner}`}** (${game.lastRoll[`total${winner}`]} > ${game.lastRoll[`total${opponentNum}`]}). ¡Ahora están **ATACANDO**!`;
            } else {
                game.statusMessage = "**EMPATE:** ¡Ambos lados vuelven a tirar inmediatamente!";
            }
            break;

        case 'A': 
            game.lastRoll.details = `Resultado del enfrentamiento: ${attackerName} Ataque (A vs D):`;
            if (winner === game.attacker) {
                game.ballArea = 'G'; 
                game.statusMessage = `**GANADOR: ${attackerName}** (${game.lastRoll[`total${game.attacker}`]} > ${game.lastRoll[`total${game.defender}`]}). ¡**OPORTUNIDAD DE GOL**!`;
            } else if (winner === game.defender) {
                game.statusMessage = `**GANADOR: ${defenderName}** (${game.lastRoll[`total${game.defender}`]} > ${game.lastRoll[`total${game.attacker}`]}). El balón vuelve al mediocampo. **Fase +1**!`;
                endPhase(roomId); // Llamada con roomId
            } else {
                game.statusMessage = "**EMPATE:** El lado atacante retiene la posesión. ¡Vuelve a tirar!";
            }
            break;

        case 'G': 
            game.lastRoll.details = `Resultado del enfrentamiento: Oportunidad de Gol (sin modificar - según reglas):`;
            if (winner === game.attacker) {
                game[`p${game.attacker}`].score++;
                game.statusMessage = `**¡GOL** para ${attackerName}! La pelota vuelve al mediocampo. **Fase +1**!`;
                endPhase(roomId); // Llamada con roomId
            } else if (winner === game.defender) {
                game.statusMessage = `**¡ATAJADA** de ${defenderName}! La pelota vuelve al mediocampo. **Fase +1**!`;
                endPhase(roomId); // Llamada con roomId
            } else {
                game.statusMessage = "**EMPATE:** ¡El delantero sigue en el rebote! Vuelve a tirar!";
            }
            break;
    }
}

function handleRoll(roomId, playerNum, socket) {
    const game = getGame(roomId);
    if (!game || game.gameOver || !game.isSetupComplete) return;

    const isP1 = playerNum === 1;
    const self = game[`p${playerNum}`];
    const opponentNum = isP1 ? 2 : 1;
    const opponentSocketId = isP1 ? game.p2SocketId : game.p1SocketId;
    
    // --- A. ACTION: ADVANCE/RE-ROLL ---
    if (game.p1Rolled && game.p2Rolled) {
        // Simplemente permitimos la nueva tirada limpiando las flags.
        game.p1Rolled = false;
        game.p2Rolled = false;
        game.lastRoll = { roll1: '?', roll2: '?', total1: 0, total2: 0, details: '' };
        
        game.statusMessage = `**¡LISTO!** Comienza la siguiente confrontación.`;
        if (game.ballArea === 'M') {
             game.statusMessage = `**¡KICK OFF!** Tira para la batalla del mediocampo.`;
        }
        
        io.to(roomId).emit('stateUpdate', game);
        return; 
    }

    // --- B. ACTION: ROLL VALIDATION ---
    if ((isP1 && game.p1Rolled) || (!isP1 && game.p2Rolled)) {
        game.statusMessage = `**ESPERA:** Jugador ${playerNum}, ya has tirado en esta confrontación. Esperando a Jugador ${opponentNum}.`;
        socket.emit('stateUpdate', game); 
        return;
    }
    
    // Validar si el jugador tiene rol activo
    if (game.ballArea !== 'M') {
        const isAttacker = game.attacker === playerNum;
        const isDefender = game.defender === playerNum;
        if (!isAttacker && !isDefender) {
            game.statusMessage = `**ESPERA:** No tienes rol activo en esta zona.`;
            socket.emit('stateUpdate', game); 
            return;
        }
    }

    // --- PERFORM ROLL AND MODIFICATION ---
    const rollValue = rollD6();
    let modValue = 0;
    
    if (game.ballArea === 'M') {
        modValue = self.M;
    } else if (game.ballArea === 'A') {
        modValue = (game.attacker === playerNum) ? self.A : self.D;
    } else if (game.ballArea === 'G') {
        modValue = 0; 
    }
    
    const rollTotal = rollValue + modValue;

    if (isP1) {
        game.p1Rolled = true;
        game.lastRoll.roll1 = rollValue;
        game.lastRoll.total1 = rollTotal;
    } else {
        game.p2Rolled = true;
        game.lastRoll.roll2 = rollValue;
        game.lastRoll.total2 = rollTotal;
    }
    
    if (game.p1.name === 'Player 1' && game.p1SocketId) game.p1.name = `Player 1 (P1)`;
    if (game.p2.name === 'Player 2' && game.p2SocketId) game.p2.name = `Player 2 (P2)`;


    // --- C. EMISSION LOGIC ---

    if (game.p1Rolled && game.p2Rolled) {
        resolveConfrontation(roomId); 
        io.to(roomId).emit('stateUpdate', game);
    } else {
        const selfName = self.name || `Jugador ${playerNum}`;
        const opponentName = game[`p${opponentNum}`].name || `Jugador ${opponentNum}`;

        // Mensaje privado para el jugador que tiró (incluye su resultado)
        const selfMessage = `${selfName} ha tirado **${rollValue}** (+${modValue} = **${rollTotal}**). Esperando la tirada de ${opponentName}...`;
        
        // Mensaje para el oponente
        const opponentMessage = `${selfName} ha tirado. Es tu turno. ¡A rodar el dado!`;

        // 2a. Enviar estado completo + mensaje al jugador que tiró
        game.statusMessage = selfMessage;
        socket.emit('stateUpdate', game); 
        
        // 2b. Crear y enviar estado CENSURADO al oponente
        if (opponentSocketId) {
            const opponentCensoredGame = JSON.parse(JSON.stringify(game));
            
            if (isP1) {
                opponentCensoredGame.lastRoll.roll1 = '?';
                opponentCensoredGame.lastRoll.total1 = 0;
            } else {
                opponentCensoredGame.lastRoll.roll2 = '?';
                opponentCensoredGame.lastRoll.total2 = 0;
            }
            opponentCensoredGame.statusMessage = opponentMessage;
            
            io.to(opponentSocketId).emit('stateUpdate', opponentCensoredGame);
        }
        
        game.statusMessage = `Esperando tirada de ${opponentName}...`;
    }
}

// --- MANEJO DE CONEXIONES Y SOCKETS (LÓGICA DE SALAS) ---
io.on('connection', (socket) => {
    
    let role = 0;
    let currentRoomId = null; 
    let isReconnecting = false;
    
    // ENVIAR LISTA DE SALAS AL CONECTARSE
    broadcastActiveRooms();

    // 1. Manejar la solicitud para unirse o crear una sala
    socket.on('joinRoom', (roomId, playerName) => { 
        if (!roomId || currentRoomId) return; 
    
        let game = games[roomId];
        
        // Crear sala si no existe
        if (!game) {
            game = initializeGameState();
            games[roomId] = game;
            console.log(`Sala ${roomId} creada.`);
        }

        // =========================================================================
        // === Priorizar la verificación de TIMEOUT para manejar el REFRESH ===
        // =========================================================================
        
        // 1. Intentar RECONECTAR: Si existe un timeout de abandono para un slot, tomarlo y cancelarlo.
        if (clearAbandonmentTimeout(roomId, 1)) {
            role = 1;
            game.p1SocketId = socket.id;
            game.p1.name = playerName || 'Player 1';
            isReconnecting = true;
        } else if (clearAbandonmentTimeout(roomId, 2)) {
            role = 2;
            game.p2SocketId = socket.id;
            game.p2.name = playerName || 'Player 2';
            isReconnecting = true;
        } 
        
        // 2. Si el rol no está asignado, ASIGNAR a un slot libre o identificar la conexión existente.
        if (role === 0) {
            if (game.p1SocketId === null) {
                role = 1;
                game.p1SocketId = socket.id;
                game.p1.name = playerName || 'Player 1';
            } else if (game.p2SocketId === null) {
                role = 2;
                game.p2SocketId = socket.id;
                game.p2.name = playerName || 'Player 2';
            } else if (game.p1SocketId === socket.id) { 
                role = 1; // El mismo socket se unió de nuevo
            } else if (game.p2SocketId === socket.id) { 
                role = 2; // El mismo socket se unió de nuevo
            } else {
                // Sala llena (Ambos slots ocupados y no hay timeouts pendientes)
                socket.emit('gameFull'); 
                return;
            }
        }
        
        // =========================================================================
        // === END: Priorizar la verificación de TIMEOUT para manejar el REFRESH ===
        // =========================================================================

        // Si hay una reconexión exitosa, limpiar el estado de abandono
        if (isReconnecting) {
            game.abandonedBy = null; 
        }

        // Unir el socket a la sala
        socket.join(roomId);
        currentRoomId = roomId;
        game.playerCount = (game.p1SocketId !== null ? 1 : 0) + (game.p2SocketId !== null ? 1 : 0);
        
        
        const roleName = game[`p${role}`].name || `Jugador ${role}`;
        console.log(`${roleName} unido a la Sala ${roomId}.`);
        
        if (game.playerCount === 2) {
            game.statusMessage = `¡Ambos jugadores conectados! ${isReconnecting ? '(Reconectado)' : ''} Configura tus ${RULES_MAX_POINTS} puntos de táctica.`;
        } else {
            game.statusMessage = `Conectado como ${roleName}. Esperando oponente.`;
        }
        
        socket.emit('roleAssignment', role, game.p1.name, game.p2.name); // Añadir nombres para el cliente
        io.to(roomId).emit('stateUpdate', game);
        
        // ENVIAR LISTA DE SALAS AL UNIRSE (Se actualiza si se llena o se crea una nueva)
        broadcastActiveRooms();
    });

    // 2. Configuración de Tácticas (Setup)
    socket.on('setup', (data) => {
        if (!currentRoomId || data.role !== role) return;
        
        const game = getGame(currentRoomId);
        if (!game) return;

        const { d, m, a } = data;
        
        if (
            d + m + a !== 10 ||
            d < 2 || d > 5 ||
            m < 3 || m > 6 ||
            a < 1 || a > 4
        ) {
            io.to(socket.id).emit('stateUpdate', {...game, statusMessage: `Tácticas inválidas. Rangos: Defence 2–5 | Midfield 3–6 | Attack 1–4 (Total 10)`});
            return;
        }

        const roleName = game[`p${role}`].name || `Jugador ${role}`;
        
        if (role === 1) {
            game.p1.D = d;
            game.p1.M = m;
            game.p1.A = a;
            game.statusMessage = `${roleName} ha bloqueado sus tácticas. Jugador 2, es tu turno.`;
        } else if (role === 2) {
            game.p2.D = d;
            game.p2.M = m;
            game.p2.A = a;
            game.statusMessage = `${roleName} ha bloqueado sus tácticas.`;
        }
        
        // Comprobar si ambos han enviado las tácticas
        const p1Submitted = (game.p1.D + game.p1.M + game.p1.A) === RULES_MAX_POINTS;
        const p2Submitted = (game.p2.D + game.p2.M + game.p2.A) === RULES_MAX_POINTS;
        
        if (p1Submitted && p2Submitted) {
            game.isSetupComplete = true;
            game.statusMessage = `¡Tácticas bloqueadas! Ambos jugadores listos. ¡A rodar el dado!`;
        }

        io.to(currentRoomId).emit('stateUpdate', game); 
    });

    // 3. Tirada de Dados (Roll)
    socket.on('rollAction', () => {
        if (!currentRoomId) return;
        
        const game = getGame(currentRoomId);
        if (!game.isSetupComplete) {
            io.to(socket.id).emit('stateUpdate', {...game, statusMessage: "Espera a que ambos jugadores configuren sus tácticas."});
            return;
        }
        handleRoll(currentRoomId, role, socket); 
    });
    
    // 4. Solicitud de Nuevo Juego (Sincronizado)
    socket.on('playerReadyForNewGame', () => { 
        if (!currentRoomId) return;
        
        const game = getGame(currentRoomId);
        
        if (!game.gameOver) return;

        if (role === 1) {
            game.p1ReadyForNewGame = true;
        } else if (role === 2) {
            game.p2ReadyForNewGame = true;
        }
        
        const playerSlotReady = (role === 1) ? 'p1ReadyForNewGame' : 'p2ReadyForNewGame';
        const otherPlayerSlotReady = (role === 1) ? 'p2ReadyForNewGame' : 'p1ReadyForNewGame';
        const otherPlayerRole = (role === 1) ? 2 : 1;
        
        const otherPlayerAbandoned = game.abandonedBy === `p${otherPlayerRole}`;

        if (game[playerSlotReady] && (game[otherPlayerSlotReady] || otherPlayerAbandoned)) {
            
            if (otherPlayerAbandoned) {
                game[otherPlayerSlotReady] = false; 
                game.abandonedBy = null; // Limpiar el estado de abandono
            }
            
            resetGame(currentRoomId); 
            
            if (game.playerCount < 2) {
                // Si el otro jugador no está (o abandonó), solo emitimos al jugador que hizo click
                socket.emit('goToSetup', game); 
            } else {
                 io.to(currentRoomId).emit('stateUpdate', game); 
            }
            
        } else {
            const otherRoleName = game[`p${otherPlayerRole}`].name || `Jugador ${otherPlayerRole}`;
            game.statusMessage = `¡${game[`p${role}`].name} ya está listo! Esperando a ${otherRoleName} para iniciar una nueva partida...`;

            io.to(currentRoomId).emit('stateUpdate', game); 
        }
    });

    // 5. Desconexión NO CONTROLADA (Abandono/Timeout)
    socket.on('disconnect', () => {
        if (!currentRoomId) return;
        
        const game = getGame(currentRoomId);
        if (!game) return;

        // 1. Determinar el rol que se desconectó
        let disconnectedRole = null;
        if (socket.id === game.p1SocketId) {
            disconnectedRole = 1;
        } else if (socket.id === game.p2SocketId) {
            disconnectedRole = 2;
        }
        
        if (disconnectedRole === null) return; 
        
        const disconnectedPlayerName = game[`p${disconnectedRole}`].name || `Jugador ${disconnectedRole}`;
        
        // 2. Lógica de Abandono/Reconexión
        if (!game.gameOver || (game.gameOver && !game.abandonedBy)) { 
            
            console.log(`${disconnectedPlayerName} desconectado. Iniciando timeout de abandono (${ABANDONMENT_TIMEOUT_MS/1000}s).`);
            
            const timeoutKey = `${currentRoomId}_${disconnectedRole}`;
            
            // Creamos el nuevo timeout
            disconnectTimeouts[timeoutKey] = setTimeout(() => {
                
                console.log(`Timeout expirado para ${disconnectedPlayerName} en ${currentRoomId}. Declarando abandono.`);
                
                const remainingRole = (disconnectedRole === 1) ? 2 : 1;
                const remainingPlayerSocketId = (remainingRole === 1) ? game.p1SocketId : game.p2SocketId;

                // 1. Declarar al ganador por abandono y notificar (emite stateUpdate con gameOver=true)
                if (!game.gameOver) {
                    declareWinnerByAbandonment(currentRoomId, disconnectedRole);
                }
                
                // === LÓGICA DE REDIRECCIÓN AUTOMÁTICA AL SETUP ===
                if (remainingPlayerSocketId) {
                    
                    // 2. Restablecer el estado para empezar una nueva partida
                    game.gameOver = false;
                    game.abandonedBy = null;
                    game[`p${remainingRole}ReadyForNewGame`] = false; 
                    
                    // 3. Resetear el juego (limpia fases, scores, setups, pero mantiene nombres y IDs)
                    resetGame(currentRoomId); 
                    
                    // 4. Enviar evento de transición al cliente restante para ir a SETUP
                    io.to(remainingPlayerSocketId).emit('goToSetup', game); 
                    console.log(`Jugador ${remainingRole} forzado a la pantalla de SETUP.`);
                }
                // === FIN: LÓGICA DE REDIRECCIÓN AUTOMÁTICA AL SETUP ===
                
                // Liberar el slot del socket permanentemente
                const slotId = (disconnectedRole === 1) ? 'p1SocketId' : 'p2SocketId';
                game[slotId] = null;
                game.playerCount = (game.p1SocketId !== null ? 1 : 0) + (game.p2SocketId !== null ? 1 : 0);
                
                if (game.playerCount === 0) {
                    delete games[currentRoomId];
                    console.log(`Sala ${currentRoomId} eliminada por estar vacía.`);
                }
                
                delete disconnectTimeouts[timeoutKey];
                
                // ENVIAR LISTA DE SALAS AL ELIMINAR/LIBERAR SLOT
                broadcastActiveRooms();
            }, ABANDONMENT_TIMEOUT_MS);
        }
        
        // Liberar el slot del socket inmediatamente para permitir la reconexión rápida
        if (socket.id === game.p1SocketId) {
            game.p1SocketId = null;
        } else if (socket.id === game.p2SocketId) {
            game.p2SocketId = null;
        }
        
        game.playerCount = (game.p1SocketId !== null ? 1 : 0) + (game.p2SocketId !== null ? 1 : 0);

        // Notificar a la sala restante sobre la desconexión
        if (game.playerCount === 1) {
            const message = `¡${disconnectedPlayerName} se ha desconectado! Esperando reconexión por ${ABANDONMENT_TIMEOUT_MS/1000} segundos...`;
            game.statusMessage = message; 
            io.to(currentRoomId).emit('stateUpdate', game);
        } else if (game.playerCount === 0) {
            console.log(`Jugador ${disconnectedRole} de la Sala ${currentRoomId} desconectado. Jugadores restantes: 0.`);
        }
    });

    // 6. Abandono controlado y vuelta al lobby (NUEVO)
    socket.on('leaveRoom', () => {
        if (!currentRoomId || role === 0) return;

        const game = getGame(currentRoomId);
        if (!game) return;

        console.log(`${game[`p${role}`].name} (${role}) está saliendo de la Sala ${currentRoomId} intencionalmente.`);

        const oldRoomId = currentRoomId;
        const disconnectedRole = role;

        // Limpiar el slot del jugador en el juego
        const slotId = (disconnectedRole === 1) ? 'p1SocketId' : 'p2SocketId';
        game[slotId] = null;

        // Limpiar variables de socket local (IMPORTANTE)
        role = 0;
        currentRoomId = null;

        // 1. Abandonar la sala de Socket.IO
        socket.leave(oldRoomId);

        // 2. Actualizar el contador
        game.playerCount = (game.p1SocketId !== null ? 1 : 0) + (game.p2SocketId !== null ? 1 : 0);
        
        // 3. Notificar al otro jugador si existe
        if (game.playerCount === 1) {
            const remainingRole = (disconnectedRole === 1) ? 2 : 1;
            const remainingPlayerSocketId = (remainingRole === 1) ? game.p1SocketId : game.p2SocketId;
            
            // Cancelar el timeout de abandono del otro jugador si estaba activo
            clearAbandonmentTimeout(oldRoomId, remainingRole); 

            if (remainingPlayerSocketId) {
                game.statusMessage = `¡${game[`p${disconnectedRole}`].name} ha salido de la sala! Esperando un nuevo oponente...`;
                io.to(remainingPlayerSocketId).emit('stateUpdate', game); 
            }
        }
        
        // 4. Limpieza de sala si está vacía
        if (game.playerCount === 0) {
            delete games[oldRoomId];
            console.log(`Sala ${oldRoomId} eliminada por estar vacía después de la salida controlada.`);
        }
        
        // 5. Informar al cliente que puede ir al lobby
        socket.emit('goToLobby');

        // 6. Actualizar lista de salas para todos
        broadcastActiveRooms();
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
