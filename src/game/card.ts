import Random from "../utils/random";
import ArrayUtils from "../utils/arrayutils";
import PlayerInputType from "./playerinputtype";
import GameSession from "../network/gamesession";
import Bugsnag from "@bugsnag/js";
import Player from "./player";

export class Buff {
    name: string;
    target: string;
    param: string; //todo enum
    value: number;
    chance: number;
    condition: number;
    synergy: number;
    disableStacking: boolean;
}

export class EquipmentSlot {
    static Implant = 0;
    static Head = 1;
    static Melee = 2;
    static Ranged = 3;
    static Torso = 4;
    static Legs = 5;
}

export class DurationType {
    static Turn = 1;
    static Defend = 2;
    static AttackMelee = 3;
    static AttackRanged = 4;
}

export default class Card {

    sessionLog: (log: string) => void;
    instanceId: number;
    id: number;
    name: string;
    description: string;
    willpowerCost: number;
    buffs: Buff[];
    criticalOnly: boolean;
    summon: Card;
    equipmentSlot: number;
    triggers: any;
    duration: { type: number; value: number; };
    sacrifice: any;
    resultDelay: any;

    static GET_RANDOM_WORD() {
        var card = Card.data[Random.range(0, Card.data.length - 1)];
        var words = card.name.split(' ');
        return words[Random.range(0, words.length - 1)];
    }

    static data: Card[];

    static draw(deck) {
        console.log(deck);
        if (deck.length < 1)
            return -1;

        var idx = Random.range(0, deck.length - 1);
        var value = deck[idx];

        deck.splice(idx, 1);
        return value;
    }

    static DefendNoTriggers = {
        name: "Defend",
        buffs: [
            {
                target: "player",
                param: "damageReduction",
                value: 0.5,
                chance: 0.475
            }
        ]
    };

    static Defend = {
        name: "Defend",
        buffs: [
            {
                target: "player",
                param: "damageReduction",
                value: 0.5,
                chance: 0.475
            }
        ],
        triggers: {
            onInputProcessed: [
                {

                    action: "drawCard",
                    target: "player",
                    value: 1
                },
                {
                    action: "addWill",
                    target: "player",
                    value: 1
                }
            ]
        }
    };

    static ID = 0;
    constructor(data, id: number) {
        this.instanceId = Card.ID++;
        this.id = id;
        this.name = data.name;
        this.description = data.description;
        this.willpowerCost = data.willpowerCost;
        this.buffs = data.buffs || [];
        this.criticalOnly = data.criticalOnly;

        if (data.summon) {
            this.summon = { ...data.summon };
            this.summon.name = this.name;
        }

        this.equipmentSlot = data.equipmentSlot;

        for (var buff of this.buffs)
            buff.name = this.name;

        this.triggers = data.triggers;

        //default values
        this.duration = {
            type: DurationType.Turn,
            value: (this.equipmentSlot != null || this.summon) ? -1 : 1
        };

        if (data.duration) {
            this.duration.type = data.duration.type;
            this.duration.value = data.duration.value;
        }

        this.sacrifice = data.sacrifice;
    }

    chargeWillpower(player) {
        if (player.cardsInPlay.indexOf(this) > 0) {
            if (this.sessionLog) this.sessionLog("this card instance already applied " + this.id + ' ' + this.name);
            return false;
        }

        if (this.willpowerCost != null) {
            if (player.willpower >= this.willpowerCost) {
                player.willpower -= this.willpowerCost;
                if (this.sessionLog) this.sessionLog("willpoweer charged.. new willpower: " + player.willpower);
                return true;
            }
            else {
                if (this.sessionLog) this.sessionLog("not enough willpower: " + player.willpower + "; for " + this.id + ' ' + this.name);
                return false;
            }
        } else {
            if (this.sessionLog) this.sessionLog("card has no willpower cost: " + this.name);
            return true;
        }
    }

    apply(player:Player, opponent:Player, commands) {

        if (this.sessionLog) this.sessionLog("applying card..");

        if (this.summon) {
            player.summons.push(this.summon);
            if (this.sessionLog) this.sessionLog("added summon.. " + this.name);
        }

        if (this.equipmentSlot != null) {
            if (player.equipmentSlots[this.equipmentSlot]) {
                if (this.sessionLog) this.sessionLog("removing old equipment from slot.. " + player.equipmentSlots[this.equipmentSlot].name);
                player.equipmentSlots[this.equipmentSlot].discard(player, opponent, commands);
            }
            player.equipmentSlots[this.equipmentSlot] = this;
            if (this.sessionLog) this.sessionLog("added new equipment into slot.. " + this.name);

            player.lastEquipped = this.equipmentSlot;
        }

        player.cardsInPlay.push(this);

        this.onTrigger("onUse", player, opponent, commands);

        for (var buff of this.buffs) {

            if (this.equipmentSlot != null)
                buff.condition = this.equipmentSlot;
            else if (this.duration) {
                switch (this.duration.type) {
                    case (DurationType.AttackMelee):
                        buff.condition = EquipmentSlot.Melee;
                        break;

                    case (DurationType.AttackRanged):
                        buff.condition = EquipmentSlot.Ranged;
                        break;
                }
            }

            if (buff.target == "player")
                player.buffs.push(buff);

            else if (buff.target == "opponent")
                opponent.buffs.push(buff);
        }
    }

    discard(player, opponent, commands) {

        if (this.sessionLog) this.sessionLog("discarding " + this.name);

        var index = player.cardsInPlay.indexOf(this);
        if (index < 0)
            return;

        this.onTrigger("onEnd", player, opponent, commands);

        player.cardsInPlay.splice(index, 1);

        if (this.summon && !ArrayUtils.removeElemFrom(this.summon, player.summons))
            Bugsnag.notify(new Error("summon not found!"), function (event) {
                event.addMetadata('user', { id: player.tgId, cardName: this.name });
                return true;
            });

        for (var buff of this.buffs) {
            if (buff.target == "player")
                ArrayUtils.removeElemFrom(buff, player.buffs);
            else if (buff.target == "opponent")
                ArrayUtils.removeElemFrom(buff, opponent.buffs);
        }

        if (this.equipmentSlot != null) {
            player.equipmentSlots[this.equipmentSlot] = null;
        }
    }

    reduceDuration(type:DurationType) {
        if (this.duration.value < 0) //forever card, like equipment
            return false;

        if (this.duration.type != type)
            return false;

        this.duration.value--;
        return this.duration.value == 0;
    }

    onTrigger(triggerType, player, opponent, commands) {
        for (var triggerKey in this.triggers) {
            if (triggerType == triggerKey) {

                if ((this.triggers[triggerKey].disableStacking && player.triggerStack.indexOf(this.name) > -1)) {
                    if (this.sessionLog) this.sessionLog("trigger " + triggerType + " ignored as not stackable: " + this.name);
                    continue;
                }

                if (this.sessionLog) this.sessionLog("trigger " + triggerType + " handler found: " + this.name);
                player.triggerStack.push(this.name);
                var trigger = this.triggers[triggerKey];
                if (Array.isArray(this.triggers[triggerKey]))
                    for (var trigger of this.triggers[triggerKey])
                        this.processTrigger(trigger, player, opponent, commands)
                else
                    this.processTrigger(this.triggers[triggerKey], player, opponent, commands)
            }
        }
    }

    processTrigger(trigger, player, opponent, commands) {

        if (trigger.chance && !Random.flip(trigger.chance)) {
            if (this.sessionLog) this.sessionLog("skipping trigger due to chance: " + trigger.chance);
            return;
        }

        if (!trigger.target) {
            if (this.sessionLog) this.sessionLog("skipping trigger due to target not set!");
            return;
        }

        for (var targetElem of trigger.target.split(',')) {
            var target = null;
            var targetOpponent = null;
            if (targetElem.indexOf("player") >= 0) {
                target = player;
                targetOpponent = opponent;
            } else if (targetElem.indexOf("opponent") >= 0) {
                target = opponent;
                targetOpponent = player;
            } else if (targetElem.indexOf("this") >= 0) {
                target = this.summon;
                targetOpponent = opponent;
            }

            if (target == null) {
                if (this.sessionLog) this.sessionLog("trying to execute trigger but target invalid: " + targetElem);
                return;
            }

            this.handleTrigger(trigger, target, targetOpponent, commands);
        }
    }

    handleTrigger(trigger, target:Player, targetOpponent:Player, commands) {
        if (this.sessionLog) this.sessionLog("target found! " + trigger.target + " " + target.user.nickname);
        switch (trigger.action) {
            case ("injectAction"):
                if (this.sessionLog) this.sessionLog("attempting to inject actions..");
                if (this.sessionLog) this.sessionLog("current state: " + JSON.stringify(target.turnActions));
                var actions = [];
                for (var injected of trigger.value)
                    actions.push(typeof injected == 'object' ? injected : { type: injected });

                target.turnActions = actions;
                if (this.sessionLog) this.sessionLog("result: " + JSON.stringify(target.turnActions));
                break;

            case ("discardMove"):
                if (this.sessionLog) this.sessionLog("attempting to discard move..");
                if (this.sessionLog) this.sessionLog("current state: " + JSON.stringify(target.turnActions));

                commands.push({
                    type: "text",
                    data: { id: target.id, type: "Move Cancelled!" }
                });

                commands.push({ type: "sfx", data: { sound: "cancel_move" } });

                if (target.turnActions.length && target.turnActions[0].type != PlayerInputType.None)
                    target.turnActions = [{ type: PlayerInputType.Defend }];
                if (this.sessionLog) this.sessionLog("move cancelled!");

                break;

            case ("discardCard"):
                if (this.sessionLog) this.sessionLog("attempting to discard card..");
                if (this.sessionLog) this.sessionLog("current state: " + JSON.stringify(target.turnActions));

                if (!target.turnActions.length || target.turnActions[0].type != 2) {
                    if (this.sessionLog) this.sessionLog("cant discard card - user has a different action type");
                    break;
                }

                commands.push({
                    type: "text",
                    data: { id: target.id, type: "Card Cancelled!" }
                });

                commands.push({ type: "sfx", data: { sound: "cancel_move" } });

                target.turnActions = [];
                if (this.sessionLog) this.sessionLog("card cancelled!");

                break;
            case ("stealSummon"): //TODO: cards in play

                if (this.sessionLog) this.sessionLog("attempting to steal a summon..");

                var summon = targetOpponent.summons.length ? targetOpponent.summons[0] : null;
                if (!summon) {
                    if (this.sessionLog) this.sessionLog("opponent has no summon..");
                    break;
                }

                if (this.sessionLog) this.sessionLog("summon found: " + summon.name);

                for (var summonCard of targetOpponent.cardsInPlay) {
                    if (summonCard.name == summon.name) {
                        if (this.sessionLog) this.sessionLog("card found: " + summonCard.id);
                        if (this.sessionLog) this.sessionLog("discarding summon from target opponent..");
                        summonCard.discard(targetOpponent, target, commands) //todo remove summon
                        if (this.sessionLog) this.sessionLog("applying summon to target player..");
                        summonCard.apply(target, targetOpponent, commands);

                        commands.push({
                            type: "text",
                            data: { id: target.id, type: "Summon Stolen!" }
                        });
                        break;
                    }
                }
                break;


            case ("drawCard"):
                if (this.sessionLog) this.sessionLog("drawing cards..");

                for (var i = 0; i < trigger.value; i++) {

                    if (target.cardsDrawn.length >= GameSession.MAX_CARDS_IN_HAND) {
                        if (this.sessionLog) this.sessionLog("reached max..");
                        break;
                    }

                    var idx = Card.draw(target.user.deck);

                    if (idx < 0) {
                        if (this.sessionLog) this.sessionLog("deck empty..");
                        break;
                    }

                    if (!Card.data[idx]) {
                        Bugsnag.notify(new Error("Invalid card id: " + idx))
                        break;
                    }

                    var cardData = Card.data[idx];
                    target.cardsDrawn.push(idx);

                    cardData.instanceId = idx;
                    cardData.id = idx;
                    commands.push({
                        connectionId: target.id,
                        type: "draw",
                        data: cardData
                    });
                    if (this.sessionLog) this.sessionLog("added card:  cards.. " + cardData.name);
                }

                break;


            case ("addHP"):
                if (this.sessionLog) this.sessionLog("adding HP..");
                var prevValue = target.health;
                target.health += Random.getValue(trigger.value);

                commands.push({ type: "sfx", data: { sound: "health_up" } });
                commands.push({ type: "fx", data: { id: target.id, type: "hp_up", delay: this.resultDelay } });
                if (this.sessionLog) this.sessionLog("result: " + prevValue + "=>" + target.health);
                break;


            case ("reduceHP"):
                if (this.sessionLog) this.sessionLog("reducing HP..");
                var prevValue = target.health;
                target.health -= Random.getValue(trigger.value);
                if (this.sessionLog) this.sessionLog("result: " + prevValue + "=>" + target.health);
                break;


            case ("addWill"):
                if (this.sessionLog) this.sessionLog("adding willpower..");
                var prevValue = target.willpower;
                target.willpower += Random.getValue(trigger.value);
                if (this.sessionLog) this.sessionLog("result: " + prevValue + "=>" + target.willpower);
                break;


            case ("reduceWill"):
                if (this.sessionLog) this.sessionLog("reducing Will..");
                var prevValue = target.willpower;
                target.willpower -= Random.getValue(trigger.value);
                target.willpower = Math.max(0, target.willpower);
                if (this.sessionLog) this.sessionLog("result: " + prevValue + "=>" + target.willpower);
                break;

            case ("discardEquipment"):
                if (this.sessionLog) this.sessionLog("attempting to discard equipment..");

                var slot = null;

                if (target.lastEquipped && target.equipmentSlots[target.lastEquipped])
                    slot = target.equipmentSlots[target.lastEquipped];

                if (!slot)
                    for (var equipmentKey in trigger.value) {
                        if (target.equipmentSlots[equipmentKey] != null)
                            slot = target.equipmentSlots[equipmentKey];
                    }

                if (!slot) {
                    if (this.sessionLog) this.sessionLog("opponent has no equipment..");
                    break;
                }

                if (this.sessionLog) this.sessionLog("equipment found: " + slot.name);
                if (this.sessionLog) this.sessionLog("discarding summon from target opponent..");
                slot.discard(target, targetOpponent, commands) //todo remove summon

                commands.push({
                    type: "text",
                    data: { id: target.id, type: "equipment discarded!" }
                });
                break;

            case ("restoreArmorToken"):
                if (this.sessionLog) this.sessionLog("restiring armor token..");

                if (!target.equipmentSlots[EquipmentSlot.Torso]) {
                    if (this.sessionLog) this.sessionLog("no armor found..");
                    break;
                }


                var card = target.equipmentSlots[EquipmentSlot.Torso];
                if (this.sessionLog) this.sessionLog("armor found: " + card.name);

                if (card.duration.value < 0) {
                    if (this.sessionLog) this.sessionLog("this is undestructible, nothing to do here..");
                    break;
                }

                var prevValue = card.duration.value;
                if (this.sessionLog) this.sessionLog("result: " + prevValue + "->" + ++card.duration.value);

                break;

            case ("cancelAttack"):
                if (this.sessionLog) this.sessionLog("cancelling attacks..");

                if (this.sessionLog) this.sessionLog("current state: " + JSON.stringify(target.turnActions));

                var attackCancelled = false;

                for (var i = target.turnActions.length - 1; i >= 0; i--) {
                    switch (target.turnActions[i].type) {
                        case (PlayerInputType.AttackBest):
                        case (PlayerInputType.AttackMelee):
                        case (PlayerInputType.AttackNoWeapon):
                        case (PlayerInputType.AttackRanged):
                        case (PlayerInputType.AttackAll):
                            target.turnActions.splice(i, 1);
                            attackCancelled = true;
                            break;
                    }
                }

                if (attackCancelled) {
                    commands.push({
                        type: "text",
                        data: { id: target.id, type: "Attack Cancelled!" }
                    });
                }

                commands.push({ type: "sfx", data: { sound: "cancel_move" } });

                if (this.sessionLog) this.sessionLog("result: " + JSON.stringify(target.turnActions));

                break;

            case ("cancelMeleeAttack"):
                if (this.sessionLog) this.sessionLog("cancelling melee attacks..");

                if (this.sessionLog) this.sessionLog("current state: " + JSON.stringify(target.turnActions));

                var attackCancelled = false;

                for (var i = target.turnActions.length - 1; i >= 0; i--) {
                    switch (target.turnActions[i].type) {
                        case (PlayerInputType.AttackMelee):
                        case (PlayerInputType.AttackNoWeapon):
                            target.turnActions.splice(i, 1);
                            attackCancelled = true;
                            break;
                    }
                }

                if (attackCancelled) {
                    commands.push({
                        type: "text",
                        data: { id: target.id, type: "Attack Cancelled!" }
                    });

                    commands.push({ type: "sfx", data: { sound: "cancel_move" } });
                }

                if (this.sessionLog) this.sessionLog("result: " + JSON.stringify(target.turnActions));

                break;

            case ("setHP"): {
                if (this.sessionLog) this.sessionLog("setting HP..");
                var prevValue = target.health;
                target.health = Random.getValue(trigger.value);

                commands.push({ type: "sfx", data: { sound: "health_up" } });
                commands.push({ type: "fx", data: { id: target.id, type: "hp_up", delay: this.resultDelay } });
                if (this.sessionLog) this.sessionLog("result: " + prevValue + "=>" + target.health);
                break;
            }
            case ("missNextTurn"): {
                if (this.sessionLog) this.sessionLog("setting target to miss next turn..");
                target.ignoreInput = true;

                commands.push({
                    type: "text",
                    data: { id: target.id, type: "Miss next turn!" }
                });
                if (this.sessionLog) this.sessionLog("result: target.ignoreInput:" + target.ignoreInput);
                break;
            }
        }

    }
}