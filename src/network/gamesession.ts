import Player from "../game/player";
import Bot, { BotData } from '../game/bot';
import PlayerInputType from "../game/playerinputtype";
import Random from "../utils/random";
import Card, { EquipmentSlot, DurationType } from "../game/card";
import ArrayUtils from "../utils/arrayutils";
import { Decoder } from 'socket.io-parser';
import Bugsnag from "@bugsnag/js";
import MissionManager from "./missionmanager";
import * as tutorial from "./tutorial";
import axios from "axios";
import User from "../game/user";
import { Socket } from "socket.io";
import { DefaultEventsMap } from "socket.io/dist/typed-events";

export class SessionTerminationArgs {
    matchId: string;
    winner?: string;
    winnerId?: string;
    loserId?: string;
    hp?: number;
    chatType?: string;
    chatId?: string;
    messageId?: string;
    gameType?: string;
}

export default class GameSession {

    connections = [];
    players: { [key: string]: Player; } = {};
    opponents = {};
    opponentIds = {};
    initiative = [];

    turnDuration = 15;
    static MAX_CARDS_IN_HAND = 10;
    static ID = 0;

    packets = [];
    callback: (args: SessionTerminationArgs) => void;
    matchId: string;
    tutorialEnabled: boolean;
    started: boolean;
    stopped: boolean;
    endTurnTimeout: NodeJS.Timeout;
    resultDelay: number;
    ended: boolean;
    sessionLog: string;

    constructor(callback: (args: SessionTerminationArgs) => void, matchId: string) {
        this.callback = callback;
        this.matchId = matchId;
    }

    registerPacketLogger(socket) {
        const decoder = new Decoder();
        // inbound messages
        socket.conn.on('packet', (packet) => {
            try {
                decoder.once('decoded', ({ type, nsp, data }) => {
                    this.packets.push({ source: socket.id, destination: nsp, type, ...data });
                });
                decoder.add(packet.data);
            } catch (e) {
                // if decoding fails, unregister listener
                decoder.removeAllListeners("decoded");
            }
        });
        // outbound messages
        socket.conn.on('flush', (packets) => {
            packets.forEach(packet => {
                try {
                    decoder.once('decoded', ({ type, nsp, data }) => {
                        this.packets.push({ source: nsp, destination: socket.id, type, ...data });
                    });
                    decoder.add(packet.data)
                } catch (e) {
                    // if decoding fails, unregister listener
                    decoder.removeAllListeners("decoded");
                }
            });
        });
    }

    getPacketLogs() {
        if (this.packets.length > 0) {
            return JSON.stringify(this.packets, null, 0);
        } else {
            return null;
        }
    }

    clearPacketLogs() {
        this.packets.length = 0;
    }

    addBot(data: User, id: string) {
        if (this.players[id]) {
            console.warn("adding bot twice!!")
            return;
        }

        this.players[id] = new Player(id, data.hp || 35, data.willpower || 15);
        this.players[id].sessionLog = this.log.bind(this);
        this.players[id].user = data;
        this.players[id].status = 'waiting';

        this.players[id].bot = new Bot(data);

        this.tutorialEnabled = true;
    }

    notifyOpponent(currentPlayer:Player, data) {

        const update = {
             ...data, 
             name: currentPlayer.user.nickname, 
             race:currentPlayer.user.race, 
             portraitSrc:currentPlayer.user.portraitSrc
            };

        Object.values(this.connections)
            .filter(opponentSocket => opponentSocket.id in this.players) // is player
            .filter(opponentSocket => currentPlayer.id !== opponentSocket.id) // is not current player
            .forEach(opponentSocket => opponentSocket.emit("player_status", update));

    }

    join(socket: Socket, data:User) {

        this.log("checking if existing player in the match has the tgId...");
        for (let connection of this.connections) {
            const player = this.players[connection.id];

            if (player && player?.user?.accountId === data.accountId) {
                this.log("player found, reassigning..." + socket.id);
                player.id = socket.id;
                player.status = "";
                this.players[socket.id] = player;
                delete this.players[connection.id];
                connection.removeAllListeners();

                // on reconnection, wait until player is ready to join the fight, the start his game
                socket.on("player_status", (update) => {

                    player.status = update.status;

                    this.notifyOpponent(player, update);

                    if (this.isReady) {
                        socket.emit("prepare");
                        this.setupGameForPlayer(this.players[socket.id], false);
                        socket.emit("start", this.players);

                        socket.removeAllListeners("player_status");


                        if (player) { //player,not a spectator
                            for (var cardId of player.cardsDrawn) {
                                var cardData = new Card(Card.data[cardId], cardId);
                                cardData.id = cardId;
                                socket.emit("draw", cardData);
                                this.log("card drawn with id: " + cardId + " for player " + player.user.nickname + "..");
                            }

                            //sunscribe to user input
                            socket.on("userInput", this.onUserInput.bind(this, socket.id));
                            socket.on("chat", this.onChatMessage.bind(this, socket));
                        }
                    }
                });
            }
        }

        this.connections.push(socket);
        this.log("user joined " + socket.id + (data.accountId && data ? "" : " (spectator)"));

        this.log("prune disconnected connections..");
        for (var i = this.connections.length - 1; i >= 0; i--) {
            var connection = this.connections[i];
            if (!connection.connected) {
                this.log("deleting disconnected user: " + connection.id);
                this.connections.splice(this.connections.indexOf(connection), 1);
                delete this.players[connection.id];
            }
        }

        if (Object.keys(this.players).length > 1) {
            this.remapOpponents();
        }

        if (!data) { //spectator
            socket.on("player_status", (update) => {
                if (this.started && update.status === 'waiting') {
                    socket.removeAllListeners("player_status");
                    socket.emit("prepare");
                    socket.emit("start", this.players);
                }
            });
            return;
        }

        if (this.players[socket.id])
            return;

        this.log("creating new player for: " + data.accountId);

        const player = new Player(socket.id, data.hp || 35, data.willpower || 15);
        player.sessionLog = this.log.bind(this);
        player.user = data;
        this.players[socket.id] = player;

        this.log("player created: " + data.nickname + "..");

        // notify me my opponent status when i connect
        if (data) {
            const opponent = Object.values(this.players).find((opponent) => opponent.id !== socket.id);
            if (opponent) {
                this.notifyOpponent(opponent, { status: opponent.status });
            }
        }

        // register listener if not already present from the reconnection case
        if (socket.listenerCount("player_status") === 0) {
            socket.on("player_status", async (update) => {

                if (!player) return;

                player.status = update.status;
                this.notifyOpponent(player, update);

                if (!this.isReady)
                    return;


                for (var connection of this.connections) {
                    connection.removeAllListeners("player_status");
                }

                var startResult = await axios.post("http://battlehub-service:5000/api/v1/match/start", {
                    matchId: this.matchId,
                    chatType: socket.handshake.query.chat_type,
                    chatId: socket.handshake.query.chat_id,
                    messageId: socket.handshake.query.message_id,
                    gameType: socket.handshake.query.game_type
                }, {
                    headers: {
                        "X-API-KEY": process.env.SPHERE_API_KEY
                    }
                });
                console.log("startResult: " + startResult.status);

                if (startResult.status != 200) {
                    return;
                }


                this.prepare();

            });
        }
    }

    get isReady() {
        const readyPlayers = Object.values(this.players).filter(player => player.status === 'waiting' || player.status === 'playing');
        return readyPlayers.length === 2;
    }

    prepare() {
        for (var connection of this.connections) {
            const readyPlayers = Object.values(this.players).filter(player => player.status === "waiting");
            readyPlayers.forEach(player => player.status = "playing");
            connection.removeAllListeners("player_status");
            connection.emit("prepare");
        }

        setTimeout(() => {
            this.startGame();
        }, 2000);
    }

    startGame() {

        this.started = true;
        GameSession.ID++;

        //create players
        this.remapOpponents();

        for (var playerId in this.players)
            this.setupGameForPlayer(this.players[playerId], true);

        for (let connection of this.connections) {
            //notify players about game start
            connection.emit("start", this.players);

            if (this.players[connection.id]) { //player,not a spectator
                var player = this.players[connection.id];
                for (var id of player.cardsDrawn) {
                    var cardData = new Card(Card.data[id], id);
                    cardData.id = id;
                    connection.emit("draw", cardData);
                    this.log("card drawn with id: " + id + " for player " + player.user?.nickname + "..");
                }

                //sunscribe to user input
                connection.on("userInput", this.onUserInput.bind(this, connection.id));
                connection.on("chat", this.onChatMessage.bind(this, connection));
            }
        }


        this.resetTurn();
    }

    remapOpponents() {
        var ids = [];
        for (let playerId in this.players) {
            ids.push(playerId);
        }

        //setup references
        this.opponents[ids[0]] = this.players[ids[1]];
        this.opponents[ids[1]] = this.players[ids[0]];

        this.opponentIds[ids[0]] = ids[1];
        this.opponentIds[ids[1]] = ids[0];
    }

    setupGameForPlayer(player:Player, drawInitialCards) {
        //draw cards
        if (drawInitialCards) {
            for (var i = 0; i < 7; i++) {
                var id = Card.draw(player.user.deck);
                if (id == -1)
                    break;
                player.cardsDrawn.push(id);
            }
        }
    }

    resetTurn() {

        this.log('new turn started..');

        let anyoneConnected = false;

        for (let connection of this.connections)
            if (connection.connected) {
                anyoneConnected = true;
                break;
            }

        if (!anyoneConnected) {
            this.stopped = true;
            this.log("all players disconnected, game stopped!");
            return;
        }


        var allCritical = true;
        for (let id in this.players) {
            allCritical &&= this.players[id].health <= 0;
        }
        if (allCritical) {
            this.onRush();
        }

        var endgame = false;

        //check if a player was critical during last turn and still has <=0HP, which means end game
        for (let id in this.players) {
            if (this.players[id].critical && this.players[id].health <= 0) {
                endgame = true;
                break;
            }
        }

        //stop game
        if (endgame) {
            var winner;
            var loser;
            this.log('game ended!');

            for (var key in this.players) {
                if (this.players[key].health > 0) {
                    winner = this.players[key];
                } else {
                    loser = this.players[key];
                }
                tutorial.clear(key);
            }

            if (!winner) {
                Bugsnag.notify("Winner is null! this shouldn't happen, investigate!");
                if (this.callback)
                    this.callback({ matchId: this.matchId });
            }

            var chatType = null;
            var chatId = null;
            var messageId = null;
            var gameType = null;

            for (let connection of this.connections) {
                if (this.players[connection.id]) {
                    connection.emit("text", { id: connection.id, type: connection.id == winner.id ? "Win" : "Lose", delay: 2000 });
                    //process winner
                    if (connection.id == winner.id) {
                        MissionManager.reportMissionProgress(
                            `event.win_duel.${connection.handshake.query.actionPayload || "player"}`,
                            winner.tgId);
                    }

                    //this is obvously a bit messy cause we presume these url var would be present only in one socket
                    //as passed only whie playing vs bot.

                    //we need to create a separate layer to store match invocation source (chat message etc)
                    chatType = connection.handshake?.query?.chat_type;
                    chatId = connection.handshake?.query?.chat_id;
                    messageId = connection.handshake?.query?.message_id;
                    gameType = connection.handshake?.query?.game_type;
                }

                connection.emit("sfx", { sound: "game_over", delay: 1500 });
                connection.emit("end_game", 4000);
                connection.emit("anim", { id: winner.id, type: "Victory", delay: 1000 });
                connection.emit("anim", { id: this.opponentIds[winner.id], type: "Death", delay: 1000 });
            }

            if (this.callback)
                this.callback({
                    matchId: this.matchId,
                    winner: winner.user.nickname,
                    winnerId: winner.user.accountId,
                    loserId: winner.user.accountId,
                    hp: winner.health,
                    chatType,
                    chatId,
                    messageId,
                    gameType
                });

            return;
        }

        var gotCritical = false;
        for (let id in this.players) {
            this.players[id].critical = this.players[id].health <= 0;
            gotCritical ||= this.players[id].critical;
        }

        if (gotCritical)
            for (let connection of this.connections)
                connection.emit("sfx", { sound: "critical" });

        //set turn countdown
        if (this.turnDuration > 5)
            this.turnDuration--;

        this.initiative = [];

        for (let id in this.players) {
            var attackTargets = [];
            var noDefensiveSummons = true;
            for (var i = 0; i < this.players[id].summons.length; i++) {
                attackTargets.push(i);
                noDefensiveSummons &&= !this.players[id].summons[i].defensive;
            }

            if (noDefensiveSummons || this.opponents[id].ignoreDefensiveSummons())
                attackTargets.unshift(-1);

            this.players[id].attackTargets = attackTargets;
            this.players[id].triggerStack = [];
        }

        //notify players about new turn
        for (let connection of this.connections) {
            connection.emit("new_turn", this.turnDuration);
            connection.emit("update", { players: this.players });

            if (this.players[connection.id])
                this.players[connection.id].turnActions = [];
        }

        //start turn countdown
        this.endTurnTimeout = setTimeout(this.forceEndTurn.bind(this), 1000 * this.turnDuration);

        setTimeout(this.processBots.bind(this), 1000);

        if (this.tutorialEnabled) {
            const connection = this.connections.find(connection => this.players[connection.id].bot == null);
            const player = this.players[connection.id];
            if (player) {
                const [message, highlight_action] = tutorial.processTutorial(player);
                if (message != null) {
                    connection.emit("text", { id: connection.id, value: message, type: "Tutorial" });
                }
                if (highlight_action != null) {
                    connection.emit("highlight_action", { id: connection.id, value: highlight_action });
                }
            }
        }
    }

    processBots() {
        for (var playerId in this.players)
            if (this.players[playerId].bot)
                this.onUserInput(playerId, this.players[playerId].bot.getTurnAction(this.players[playerId], this.players[this.opponentIds[playerId]]));
    }

    forceEndTurn() {
        this.log('forcing end turn..');

        //set user input to none from anyone who didnt select an action
        for (var playerId in this.players) {
            if (!this.players[playerId].turnActions.length) {

                this.log('applying "no action" to ' + this.players[playerId].user.nickname + '..');

                this.players[playerId].turnActions.push({ type: PlayerInputType.None });
                this.initiative.push(playerId);

                //notify users
                for (var actionRecepient of this.connections) {
                    if (!this.players[actionRecepient.id])
                        continue;
                    if (actionRecepient.id != playerId)
                        actionRecepient.emit("opponent_action");
                    else
                        actionRecepient.emit("player_action", { type: PlayerInputType.None });
                }
            }
        }


        setTimeout(this.resolveTurn.bind(this), 1000);
    }

    onUserInput(id: string, data) {

        this.log('user input incoming..' + JSON.stringify(data));

        if (this.players[id].turnActions.length) {
            this.log('already registered! ' + this.players[id].turnActions[0].type);
            return;
        }

        if (!this.opponents[id]) {
            this.log('opponent disconnected.. cant accept input');
            return;
        }

        //if opponent is critical input is blocked
        if (this.opponents[id].critical) {
            this.log('opponent critical, cant accept any action..');
            return;
        }

        //if opponent is critical input is blocked
        if (this.players[id].ignoreInput) {
            this.log('player locked, cant accept any action..');
            return;
        }
        //create card instance for a selected card
        if (data.type == PlayerInputType.Card && Card.data[data.payload].criticalOnly && !this.players[id].critical) {
            this.log("Card " + Card.data[data.payload].name + " can be used only when player is critical");
            return;
        }


        this.log('accepted input ' + JSON.stringify(data));
        this.players[id].attackTarget = data.target;
        this.initiative.push(id);

        //create card instance for a selected card
        if (data.type == PlayerInputType.Card) {
            ArrayUtils.removeElemFrom(data.payload, this.players[id].cardsDrawn);
            data.card = new Card(Card.data[data.payload], data.payload);
            data.card.sessionLog = this.log.bind(this);
        }

        if (data.removeFromPlay != undefined) {
            this.log('removing card with ID: ' + data.removeFromPlay);
            var length = data.removeFromPlay.length;
            var card = ArrayUtils.FindMatch(this.players[id].cardsInPlay, "id", data.removeFromPlay);

            this.log('card found: ' + card.name);
            card.discard(this.players[id], this.opponents[id]);

            this.log('removal result: ' + length + '->' + data.removeFromPlay.length);
        }

        this.players[id].turnActions.push(data);

        //check if both players made their turn
        var canResolve = true;
        for (var playerId in this.players) {
            if (!this.players[playerId].turnActions.length) {
                canResolve = false;
            }
        }

        //acknowledge/notify action
        for (var connection of this.connections) {
            if (connection.id != id)
                connection.emit("opponent_action");
            else
                connection.emit("player_action", data);
        }

        if (canResolve) {
            clearTimeout(this.endTurnTimeout);
            this.endTurnTimeout = setTimeout(this.resolveTurn.bind(this), 1000);
        }
    }

    resolveTurn() {

        this.log('resolving turn!');
        var namesOrder = [];


        //check initiative contains valid ids (reconnect could have broken it);
        var valid = true;
        for (var id of this.initiative)
            if (!this.players[id]) {
                valid = false;
                break;
            }

        if (!valid) {
            this.initiative = Object.keys(this.players);
        }

        for (var id of this.initiative)
            namesOrder.push(this.players[id].user.nickname);

        this.log('initiative: ' + namesOrder.join(">"));

        var commands = [];

        this.log("clearing lock flags..");
        for (let id in this.players) {
            this.players[id].ignoreInput = false;
            this.log(this.players[id].user.nickname + "locked:" + this.players[id].ignoreInput);
        }


        //process cards in counter
        for (let id in this.players)
            for (var card of this.players[id].cardsInPlay)
                card.onTrigger("onPreResolve", this.players[id], this.opponents[id], commands);


        for (let id in this.players)
            for (var action of this.players[id].turnActions)
                if (action.type == PlayerInputType.Card)
                    action.card.onTrigger("onPreResolve", this.players[id], this.opponents[id], commands);

        var anySummonsAttack = this.processSummons(commands);
        this.flush(commands);

        setTimeout(this.summonsDone.bind(this), anySummonsAttack ? 1000 : 0);
    }

    summonsDone() {
        var commands = [];
        this.processInput(commands);
        this.flush(commands);

        var commands = [];
        for (let id in this.players) {
            for (var card of this.players[id].cardsInPlay)
                card.onTrigger("onInputProcessed", this.players[id], this.opponents[id], commands);
        }
        this.flush(commands);

        this.nextAction();
    }

    anyActions() {
        for (var id in this.players)
            if (this.players[id].turnActions.length)
                return true;

        return false;
    }

    nextAction() {

        this.log('--next action');
        var commands = [];

        if (!this.anyActions()) {

            this.log('no actions..');

            this.afterTurn(commands);
            this.flush(commands);
            this.resetTurn();
            return;
        }

        this.performAttack(commands);

        this.flush(commands);

        setTimeout(this.nextAction.bind(this), Math.max(2000, this.resultDelay + 1000));
    }

    flush(commands) {
        //flush all commands to clients
        for (let connection of this.connections)
            for (let command of commands)
                if (!command.connectionId || command.connectionId == connection.id)
                    connection.emit(command.type, command.data);
    }

    processInput(commands) {

        //TODO: sort turn actions by order (on accepting input)

        var resolved = {};
        for (var id in this.players)
            resolved[id] = this.players[id].turnActions;

        commands.push({ type: "resolve", data: JSON.stringify(resolved) });

        for (id of this.initiative) {

            if (!this.players[id]) {
                console.log("player disconnected");
                continue;
            }

            var action = this.players[id].turnActions.shift();
            if (!action)
                continue;

            tutorial.increaseActionCounter(id, action.type);

            switch (action.type) {

                case (PlayerInputType.None): {
                    //apply defence
                    card = new Card(Card.DefendNoTriggers, -1);
                    card.sessionLog = this.log.bind(this);
                    card.apply(this.players[id], this.opponents[id], commands);
                    break;
                }
                case (PlayerInputType.Defend): {

                    card = new Card(Card.Defend, -1);
                    card.sessionLog = this.log.bind(this);
                    card.apply(this.players[id], this.opponents[id], commands);

                    for (var card of this.players[id].cardsInPlay) {
                        card.onTrigger("onDefend", this.players[id], this.opponents[id], commands);
                    }

                    break;
                }

                case (PlayerInputType.AttackNoWeapon):
                    for (card of this.players[id].cardsInPlay)
                        card.onTrigger("onAttackNoWeapon", this.players[id], this.opponents[id], commands);

                    //generic trigger
                    for (card of this.players[id].cardsInPlay)
                        card.onTrigger("onAttack", this.players[id], this.opponents[id], commands);

                    this.players[id].turnActions.push(action);//put attacks back. a bit weird flow TODO:revisit
                    break;

                case (PlayerInputType.AttackRanged):

                    if (this.players[id].willpower > 0)
                        this.players[id].willpower--;

                    for (card of this.players[id].cardsInPlay)
                        card.onTrigger("onAttackRanged", this.players[id], this.opponents[id], commands);

                    //generic trigger
                    for (card of this.players[id].cardsInPlay)
                        card.onTrigger("onAttack", this.players[id], this.opponents[id], commands);

                    this.players[id].turnActions.push(action);//put attacks back. a bit weird flow TODO:revisit
                    break;

                case (PlayerInputType.AttackMelee):

                    if (this.players[id].willpower > 0)
                        this.players[id].willpower--;

                    for (card of this.players[id].cardsInPlay)
                        card.onTrigger("onAttackMelee", this.players[id], this.opponents[id], commands);

                    //generic trigger
                    for (card of this.players[id].cardsInPlay)
                        card.onTrigger("onAttack", this.players[id], this.opponents[id], commands);

                    this.players[id].turnActions.push(action);//put attacks back. a bit weird flow TODO:revisit
                    break;

                case (PlayerInputType.Card): { //also should trigger on equipment if relevant attack selected
                    var card = action.card as Card;

                    //todo [security] check if you iwn this card
                    if (card.chargeWillpower(this.players[id]))
                        card.apply(this.players[id], this.opponents[id], commands);
                    break;
                }
            }
        }

    }

    performAttack(commands) {

        this.log('performing attack..');

        this.resultDelay = 0;
        for (var id of this.initiative) {
            if (!this.players[id]?.turnActions?.length)
                continue;

            var actionType = this.players[id].getActionType(this.players[id].turnActions.shift());

            this.log(this.players[id].user.nickname + ' action found of type ' + actionType + '..');

            switch (actionType) {
                case (PlayerInputType.AttackNoWeapon):
                    commands.push({ type: "sfx", data: { sound: "fist_attack", delay: this.resultDelay } });
                    break;
                case (PlayerInputType.AttackAll):
                case (PlayerInputType.AttackRanged):
                    commands.push({
                        type: "sfx", data: {
                            sound:
                                this.players[id].equipmentSlots[EquipmentSlot.Ranged] && this.players[id].equipmentSlots[EquipmentSlot.Ranged].name == "Spice Cannon" ?
                                    "spice_cannon" :
                                    "ranged_attack",
                            delay: this.resultDelay
                        }
                    });
                    break;
                case (PlayerInputType.AttackMelee):
                    commands.push({ type: "sfx", data: { sound: "melee_attack" } });
                    break;
            }

            switch (actionType) {
                case (PlayerInputType.AttackNoWeapon):
                case (PlayerInputType.AttackAll):
                case (PlayerInputType.AttackRanged):
                case (PlayerInputType.AttackMelee):

                    //perform an actual attack
                    var attackerDamage = this.players[id].getDamage(actionType, this.opponents[id]);

                    //0.5 + 1 sec per 10 damage
                    this.resultDelay = Math.max(this.resultDelay, 500 + attackerDamage * 100)

                    this.onAttackInitiated(id, this.opponentIds[id], commands, actionType, attackerDamage);

                    var miss = !Random.flip(this.players[id].getAccuracy(actionType, this.opponents[id]));

                    if (miss) {
                        this.onMiss(id, this.opponentIds[id], actionType, commands, target == -1);
                        tutorial.increaseCounter(id, tutorial.Counters.MISS);
                        break;
                    } else {
                        tutorial.resetCounter(id, tutorial.Counters.MISS);
                    }

                    var targets = actionType == PlayerInputType.AttackAll ? this.opponents[id].attackTargets : [this.players[id].attackTarget];
                    for (var target of targets) {
                        var inflictedDamage = this.opponents[id].applyDamage(attackerDamage, false, this.players[id], target, actionType, commands);

                        if (inflictedDamage) {
                            if (target >= 0) {
                                commands.push({ type: "fx", data: { id: this.opponentIds[id], target: target, type: "summon_damage", delay: this.resultDelay } });
                            }
                            this.onHit(id, this.opponentIds[id], commands, inflictedDamage, target == -1, actionType);
                        } else
                            this.onDefend(id, this.opponentIds[id], commands, target == -1);
                    }

                    this.opponents[id].health = Math.max(this.opponents[id].health, 0);

                    for (var card of this.opponents[id].cardsInPlay)
                        if (card.reduceDuration(DurationType.Defend))
                            card.discard(this.opponents[id], this.players[id], commands);

                    //check if any summons got killed
                    var summonRemoved;
                    do {
                        summonRemoved = false;
                        for (var summon of this.opponents[id].summons) {
                            if (summon.health < 1) {
                                this.log("killing " + summon.name);
                                for (var summonCard of this.opponents[id].cardsInPlay) {
                                    if (summonCard.summon == summon) {

                                        summonCard.onTrigger("onKilledSelf", this.opponents[id], this.players[id], commands);

                                        this.log("card,.. " + summonCard.name);

                                        if (summon.health > 0) {
                                            this.log("Summon saved!");
                                            commands.push({
                                                type: "text",
                                                data: { id: this.opponentIds[id], type: "Summon " + summon.name + " Saved!", delay: this.resultDelay + 1200 }
                                            });
                                            break;
                                        }

                                        commands.push({
                                            type: "text",
                                            data: { id: this.opponentIds[id], type: "Summon " + summon.name + " Killed!", delay: this.resultDelay + 1200 }
                                        });
                                        summonCard.discard(this.opponents[id], this.players[id], commands) //todo remove summon

                                        summonRemoved = true;
                                        break;
                                    }

                                }
                            }
                        }
                    } while (summonRemoved);
                    break;
            }
        }
    }

    onAttackInitiated(playerId, opponentId, commands, actionType, attackerDamage) {

        for (var card of this.players[playerId].cardsInPlay) {

            if (actionType == PlayerInputType.AttackMelee && card.reduceDuration(DurationType.AttackMelee))
                card.discard(this.players[playerId], this.opponents[playerId], commands);

            if (actionType == PlayerInputType.AttackRanged && card.reduceDuration(DurationType.AttackRanged))
                card.discard(this.players[playerId], this.opponents[playerId], commands);
        }

        commands.push({
            type: "anim",
            data: { id: playerId, type: "Attack", action: actionType }
        });

        commands.push({
            type: "text",
            data: { id: playerId, type: "Attack", value: attackerDamage }
        });
    }

    onMiss(playerId, opponentId, actionType, commands, targetIsPlayer) {

        for (var card of this.players[playerId].cardsInPlay) {
            card.onTrigger("onMiss", this.players[playerId], this.players[opponentId], commands);
        }

        for (var card of this.players[opponentId].cardsInPlay) {
            card.onTrigger("onEvade", this.players[opponentId], this.players[playerId], commands);
        }

        commands.push({
            type: "text",
            data: { id: opponentId, type: "Miss", delay: this.resultDelay }
        });

        if (targetIsPlayer)
            commands.push({
                type: "anim",
                data: { id: opponentId, type: "Dodge", delay: this.resultDelay }
            });

        commands.push({ type: "fx", data: { id: opponentId, type: "miss", delay: this.resultDelay } });

        switch (actionType) {
            case (PlayerInputType.AttackMelee):
                commands.push({ type: "sfx", data: { sound: "miss_melee", delay: this.resultDelay } });
                break;
            case (PlayerInputType.AttackRanged):
                commands.push({ type: "sfx", data: { sound: "ranged_miss", delay: this.resultDelay } });
                break;
        }
    }

    onHit(playerId, opponentId, commands, inflictedDamage, targetIsPlayer, actionType) {

        if (inflictedDamage >= 20)
            MissionManager.reportMissionProgress("event.duel.inflict20dmg", this.players[playerId].user.accountId);

        for (var card of this.players[playerId].cardsInPlay) {
            card.onTrigger("onHit", this.players[playerId], this.players[opponentId], commands);
        }

        commands.push({
            type: "text",
            data: { id: opponentId, type: "Damage", value: inflictedDamage, delay: this.resultDelay }
        });

        if (targetIsPlayer)
            commands.push({
                type: "anim",
                data: { id: opponentId, type: "Hit", delay: this.resultDelay }
            });

        if (inflictedDamage >= 20)
            commands.push({ type: "sfx", data: { sound: "damage_hit_20", delay: this.resultDelay } });
        else if (inflictedDamage >= 15)
            commands.push({ type: "sfx", data: { sound: "damage_hit_15", delay: this.resultDelay } });

        switch (actionType) {
            case (PlayerInputType.AttackNoWeapon):
                commands.push({ type: "sfx", data: { sound: "melee_fist_damage", delay: this.resultDelay } });
                break;
            case (PlayerInputType.AttackMelee):
                commands.push({ type: "sfx", data: { sound: "melee_fist_damage", delay: this.resultDelay } });
                if (targetIsPlayer)
                    commands.push({ type: "fx", data: { id: opponentId, type: Math.random() < 0.5 ? "melee_hit" : "melee_hit_2", delay: this.resultDelay } });
                break;
            case (PlayerInputType.AttackRanged):
                commands.push({ type: "sfx", data: { sound: "ranged_damage", delay: this.resultDelay } });
                if (targetIsPlayer)
                    commands.push({ type: "fx", data: { id: opponentId, type: "ranged_hit", delay: this.resultDelay } });
                break;
        }
    }

    onDefend(playerId, opponentId, commands, targetIsPlayer) {
        commands.push({ type: "text", data: { id: opponentId, type: "No Damage", delay: this.resultDelay } });
        if (targetIsPlayer)
            commands.push({ type: "anim", data: { id: opponentId, type: "Block", delay: this.resultDelay } });
        commands.push({ type: "fx", data: { id: opponentId, type: "no_damage", delay: this.resultDelay } });
        commands.push({ type: "sfx", data: { sound: "no_damage", delay: this.resultDelay } });
    }

    onRush() {

        for (var playerId in this.players) {
            MissionManager.reportMissionProgress("event.duel.rush", this.players[playerId].user.accountId);
            this.players[playerId].health = 5;
        }

        for (let connection of this.connections) {
            connection.emit("text", { id: connection.id, type: "Rush", delay: 500 });
        }
    }

    afterTurn(commands) {
        //reduce duration (end of turn)
        for (let id in this.players) {
            for (var card of this.players[id].cardsInPlay) {
                card.onTrigger("onAfterTurn", this.players[id], this.opponents[id], commands);
                if (card.reduceDuration(DurationType.Turn))
                    card.discard(this.players[id], this.opponents[id], commands);
            }

            //uhgh
            for (var summon of this.players[id].summons)
                summon.ready = true;
        }
    }


    processSummons(commands) {

        var summonAttacked;
        for (let id in this.players) {

            this.resultDelay = 500;

            if (this.players[id].summonsDisabled())
                continue;

            for (var i = 0; i < this.players[id].summons.length; i++) {
                this.resultDelay += 100;
                var summon = this.players[id].summons[i];
                if (summon.damage && (!summon.chance || Random.flip(summon.chance))) {
                    var damage = Random.getValue(summon.damage);
                    commands.push({
                        type: "text",
                        data: { id: id, type: "summon_attack", index: i, value: summon.name + " attacks: " + damage, delay: i * 100 }
                    });

                    if (summon.accuracy && !Random.flip(summon.accuracy)) {
                        commands.push({
                            type: "text",
                            data: { id: this.opponentIds[i], type: "Miss", delay: this.resultDelay }
                        });
                    } else {
                        var inflictedDamage = this.opponents[id].applyDamage(damage, summon.meta == "ignoreArmor", this.players[id], null, null, commands);

                        if (inflictedDamage) {
                            for (var card of this.players[id].cardsInPlay) {
                                if (card.summon == summon) {
                                    card.onTrigger("onAttackSelf", this.players[id], this.opponents[id], commands);
                                    break;
                                }
                            }
                            this.onHit(id, this.opponentIds[id], commands, inflictedDamage, true, PlayerInputType.AttackMelee);
                        }
                        else
                            this.onDefend(id, this.opponentIds[id], commands, true);

                    }
                    summonAttacked = true;
                }
            }
        }
        return summonAttacked;
    }

    onChatMessage(initiator, data) {

        if (data.message) {
            for (let connection of this.connections)
                connection.emit("text", { id: initiator.id, value: data.message });
        }
    }

    terminate() {
        clearTimeout(this.endTurnTimeout);
        this.ended = true;
        this.log("terminate!");
        if (this.started && this.callback)
            this.callback({ matchId: this.matchId });
    }

    log(value: string) {
        if (process.env.DEBUG)
            console.log(value);

        if (!this.sessionLog)
            this.sessionLog = "";

        this.sessionLog += value + "\n";
    }
}
