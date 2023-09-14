import PlayerInputType from "./playerinputtype";
import Card, { EquipmentSlot } from "./card";
import Player from "./player";

export class BotData {
    public canKill: boolean;
}

export default class Bot {
    data: BotData;

    constructor(data: BotData) {
        this.data = data;
    }

    getTurnAction(owner: Player, opponent: Player) {

        return this.equipEmptySlot(owner, opponent) ||
            this.summon(owner, opponent) ||
            this.useNonEquipmentCard(owner, opponent) ||
            this.attack(owner, opponent) ||
            this.defend(owner, opponent);
    }

    equipEmptySlot(owner: Player, opponent: Player) {

        if (!owner.cardsDrawn) {
            return null;
        }

        var candidates = [];
        for (var cardId of owner.cardsDrawn) {
            if (Card.data[cardId].equipmentSlot !== undefined && owner.equipmentSlots[Card.data[cardId].equipmentSlot] == undefined) {
                candidates.push(cardId);
            }
        }

        return this.tryUseCard(owner, opponent, candidates);
    }

    summon(owner: Player, opponent: Player) {
        if (!owner.cardsDrawn) {
            return null;
        }

        var candidates = [];
        for (var cardId of owner.cardsDrawn) {
            if (Card.data[cardId].summon) {
                candidates.push(cardId);
            }
        }

        return this.tryUseCard(owner, opponent, candidates);
    }

    useNonEquipmentCard(owner: Player, opponent: Player) {
        if (!owner.cardsDrawn) {
            return null;
        }

        var candidates = [];
        for (var cardId of owner.cardsDrawn) {
            var cardData = Card.data[cardId];
            if (cardData.equipmentSlot == undefined && !owner.cardsInPlay.some(e => e.name == cardData.name)) {
                candidates.push(cardId);
            }
        }

        return this.tryUseCard(owner, opponent, candidates);
    }

    tryUseCard(owner: Player, opponent: Player, candidateCardIds: number[]) {

        if (!candidateCardIds?.length)
            return null;

        for (var cardId of candidateCardIds) {
            if (!Card.data[cardId].willpowerCost || Card.data[cardId].willpowerCost <= owner.willpower)
                return {
                    type: PlayerInputType.Card,
                    payload: cardId
                };
        }

        //you do have cards but not enough willpower for any of them
        return this.defend(owner, opponent);
    }

    attack(owner: Player, opponent: Player) {
        if (opponent.health < 10 && !this.data.canKill)
            return null;

        if (owner.willpower < 1)
            return null;

        var action = PlayerInputType.AttackNoWeapon;
        if (owner.equipmentSlots[EquipmentSlot.Melee])
            action = PlayerInputType.AttackMelee;
        else if (owner.equipmentSlots[EquipmentSlot.Ranged])
            action = PlayerInputType.AttackRanged;

        var target = opponent.attackTargets.length > 0 ? opponent.attackTargets[opponent.attackTargets.length - 1] : null;

        return {
            type: action,
            target: target
        };
    }

    defend(owner: Player, opponent: Player) {
        return {
            type: PlayerInputType.Defend
        };
    }
}