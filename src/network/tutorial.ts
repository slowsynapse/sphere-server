import PlayerInputType from "../game/playerinputtype";

export const Counters = {
    MISS: 'miss',
    NO_ACTION: 'no action',
    NO_CARD_USED: 'no card'
}

const thresholds = {
    [Counters.MISS]: 3,
    [Counters.NO_ACTION]: 3,
    [Counters.NO_CARD_USED]: 7,
    ['health']: 5,
    ['willpower']: 5,
}

export const TutorialCase = {
    LOW_HEALTH: 0,
    NO_ACTION: 1,
    LOW_WILLPOWER: 2,
    NO_CARDS: 3,
    NO_CARD_USED: 4,
    LOW_ACCURACY: 5
}

export const HighlightTarget = {
    DEFEND: 0,
    PUNCH: 1,
    CARDS_ALL: 2,
    CARDS_HEALTH: 3,
    CARDS_WILLPOWER: 4
}

const playerActionCounters = {};

export function processTutorial(player) {


    const { id: playerId, willpower, health, cardsDrawn: cards, deck } = player;

    if (!(playerId in playerActionCounters)) {
        playerActionCounters[playerId] = {};
    }

    // poor man's pattern matching...
    switch (true) {
        // no cards left
        case cards.length === 0 && deck.length > 0: {
            return [TutorialCase.NO_CARDS, HighlightTarget.DEFEND];
        }
        // low health but can heal
        case health < thresholds['health'] && canHeal(cards): {
            return [TutorialCase.LOW_HEALTH, HighlightTarget.CARDS_HEALTH];
        }
        // not using cards
        case playerActionCounters[playerId][Counters.NO_CARD_USED] > thresholds[Counters.NO_CARD_USED] && cards.length > 0: {
            return [TutorialCase.NO_CARD_USED, HighlightTarget.CARDS_ALL];
        }
        // low willpower
        case health < thresholds['willpower']: {
            return [TutorialCase.LOW_WILLPOWER, HighlightTarget.DEFEND];
        }
        // missing but can improve accuracy
        case playerActionCounters[playerId][Counters.MISS] > thresholds[Counters.MISS] && canImproveAccuracy(willpower, cards): {
            return [TutorialCase.LOW_ACCURACY, HighlightTarget.CARDS_WILLPOWER];
        }
        // not performing any actions
        case playerActionCounters[playerId][Counters.NO_ACTION] > thresholds[Counters.NO_ACTION]: {
            return [TutorialCase.NO_ACTION, HighlightTarget.PUNCH];
        }
        default: {
            return [null, null];
        }
    }
}

function canHeal(cards) {
    // Medkit or Pain killers
    return cards.some(card => [32, 49].includes(Number(card)));
}

function canImproveAccuracy(willpower, cards) {
    // Antigrav Boots, Heads Up Display, Love Chain of Athena, Spice Cannon or Aimbot
    return cards.some(card => [18, 20, 29, 30, 40].includes(Number(card)));
}

export function resetCounter(playerId, action) {
    if (!(playerId in playerActionCounters)) {
        playerActionCounters[playerId] = {};
    }
    playerActionCounters[playerId][action] = 0;
}

export function increaseCounter(playerId, action) {
    if (!(playerId in playerActionCounters)) {
        playerActionCounters[playerId] = {};
    }
    playerActionCounters[playerId][action] = (playerActionCounters[playerId][action] || 0) + 1;
}


export function increaseActionCounter(playerId, action) {
    if (!(playerId in playerActionCounters)) {
        playerActionCounters[playerId] = {};
    }

    if (action === PlayerInputType.None) {
        increaseCounter(playerId, Counters.NO_ACTION);
    } else {
        resetCounter(playerId, Counters.NO_ACTION);
    }

    if (action !== PlayerInputType.Card) {
        increaseCounter(playerId, Counters.NO_CARD_USED);
    } else {
        resetCounter(playerId, Counters.NO_CARD_USED);
    }
}

export function clear(playerId) {
    delete playerActionCounters[playerId];
}
