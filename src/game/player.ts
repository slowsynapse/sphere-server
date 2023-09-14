import Random from "../utils/random";
import Bot from "./bot";
import Card, { Buff, EquipmentSlot } from "./card";
import PlayerInputType from "./playerinputtype";
import User from "./user";

export default class Player {
  sessionLog: (log: string) => void;

  static BaseAccuracy = 0.8;

  id: string;

  health: number;
  willpower: number;
  attackTarget: string;
  cardsInPlay: Card[] = [];
  buffs: Buff[] = [];
  cardsDrawn = [];
  equipmentSlots = {};
  summons = [];
  turnActions: { type: PlayerInputType; card?: Card }[] = [];
  attackTargets = [];
  triggerStack = [];
  status: string;
  bot?: Bot;

  critical: boolean;
  ignoreInput: boolean;

  user?: User;
  lastEquipped: number;

  constructor(id: string, health: number, willpower: number) {
    this.id = id;
    this.health = health;
    this.willpower = willpower;
  }

  getActionType(action: { type: PlayerInputType }) {
    if (!action) return null;

    //TODO:check damage, instead of melee first
    if (action.type == PlayerInputType.AttackBest) {
      if (this.equipmentSlots[EquipmentSlot.Melee])
        return PlayerInputType.AttackMelee;
      if (this.equipmentSlots[EquipmentSlot.Ranged])
        return PlayerInputType.AttackRanged;
      return PlayerInputType.AttackNoWeapon;
    }

    return action.type;
  }

  getDamage(action: PlayerInputType, opponent: Player) {
    if (this.sessionLog) this.sessionLog("getDamage..");

    var damage = 0;

    if (action == PlayerInputType.AttackNoWeapon) {
      damage += Random.getValue("1d6");
      if (this.sessionLog) this.sessionLog("fist damage = " + damage);
    }

    if (action == PlayerInputType.AttackAll) {
      damage += Random.getValue("1d6");
      if (this.sessionLog) this.sessionLog("granade damage = " + damage);
    }

    for (var buff of this.buffs) {
      if (buff.param == "damage" && this.evaluateBuff(buff, action, opponent)) {
        damage += Random.getValue(buff.value);
        if (this.sessionLog)
          this.sessionLog("buff[damage]: damage = " + damage);
      }
    }

    for (var buff of this.buffs) {
      if (
        buff.param == "damageMult" &&
        this.evaluateBuff(buff, action, opponent)
      ) {
        damage *= Random.getValue(buff.value);
        damage = Math.ceil(damage);
        if (this.sessionLog)
          this.sessionLog("buff[damageMult]: damage = " + damage);
      }
    }

    return damage;
  }

  getAccuracy(action: PlayerInputType, opponent: Player) {
    if (this.sessionLog) this.sessionLog("getAccuracy..");
    if (this.willpower < 1 && action != PlayerInputType.AttackNoWeapon) {
      if (this.sessionLog) this.sessionLog("no willpower: accuracy = 0.1");
      return 0.1;
    }

    var accuracy = Player.BaseAccuracy;
    if (this.sessionLog) this.sessionLog("base: accuracy = " + accuracy);

    var stack = [];
    for (var buff of this.buffs) {
      if (buff.disableStacking) {
        if (stack.includes(buff.name)) {
          if (this.sessionLog)
            this.sessionLog(
              "Ignoring buff " +
                buff.name +
                " as non stackable. Current stack: " +
                stack.join(",") +
                ".."
            );
          continue;
        } else stack.push(buff.name);
      }
      if (
        buff.param == "accuracy" &&
        this.evaluateBuff(buff, action, opponent)
      ) {
        accuracy += buff.value;
        if (this.sessionLog)
          this.sessionLog(
            "buff found: accuracy modified by " +
              buff.value +
              " and set to " +
              accuracy +
              ".."
          );
      }
    }
    return accuracy;
  }

  applyDamage(value, ignoreArmor, attacker, targetId, actionType, commands) {
    if (this.sessionLog) this.sessionLog("applyDamage..");
    if (this.sessionLog) this.sessionLog("ignoreArmor = (" + ignoreArmor + ")");
    if (this.sessionLog) this.sessionLog("base: damage = " + value);
    if (this.sessionLog) this.sessionLog("target = " + targetId);

    if (targetId != null && this.summons.length <= targetId)
      console.warn("invalid target: " + targetId);

    var summon = null;
    if (targetId != null && targetId >= 0 && this.summons.length > targetId) {
      if (this.sessionLog) this.sessionLog("trying to hit summon..");

      if (this.summons[targetId].ready) {
        summon = this.summons[targetId];
        if (this.sessionLog) this.sessionLog("will hit summon " + summon.name);
      }
    }

    //apply armor and damage reduction
    if (!ignoreArmor && (summon == null || summon.applyArmor)) {
      if (this.sessionLog) this.sessionLog("applying armor buffs because:");
      if (this.sessionLog) this.sessionLog("\tignoreArmor: " + ignoreArmor);
      if (this.sessionLog) this.sessionLog("\tis summon: " + (summon != null));
      if (summon)
        if (this.sessionLog)
          this.sessionLog("\tsummon.applyArmor: " + summon.applyArmor);

      for (var buff of this.buffs) {
        if (
          buff.param == "damageReduction" &&
          this.evaluateBuff(buff, actionType, attacker)
        ) {
          value *= 1 - buff.value;
          value = Math.ceil(value);
          if (this.sessionLog)
            this.sessionLog("buff [damageReduction]: damage = " + value);
        }
      }

      for (var buff of this.buffs) {
        if (
          buff.param == "armor" &&
          this.evaluateBuff(buff, actionType, attacker)
        ) {
          value -= Random.getValue(buff.value);
          if (this.sessionLog)
            this.sessionLog("buff [armor]: damage = " + value);
        }
      }
    }

    if (value <= 0) {
      if (this.sessionLog) this.sessionLog("damage reduced to 0!");
      return 0;
    }

    if (summon) {
      var dmg = Math.min(summon.health, value);
      if (this.sessionLog)
        this.sessionLog("attacking summon with " + dmg + " damage");
      if (dmg > 0) {
        summon.health -= dmg;
        if (this.sessionLog)
          this.sessionLog(
            "summon " + summon.name + " HP reduced to " + summon.health
          );

        for (var card of this.cardsInPlay) {
          if (card.summon == summon) {
            card.onTrigger("onSummonHit", this, attacker, commands);
            break;
          }
        }
      }
      return dmg;
    }

    if (value > this.health) {
      if (this.sessionLog) this.sessionLog("clamping damage to " + this.health);
      value = this.health;
    }

    if (this.sessionLog)
      this.sessionLog("attacking player with " + value + " damage");
    this.health -= value;

    return value;
  }

  summonsDisabled() {
    if (this.sessionLog) this.sessionLog("checking if can use summons.. ");
    for (var buff of this.buffs) {
      if (buff.param == "disableSummons") {
        if (this.sessionLog) this.sessionLog("found disable summons buff!");
        return true;
      }
    }
    return false;
  }

  evaluateBuff(buff: Buff, action: PlayerInputType, opponent: Player) {
    if (this.sessionLog) this.sessionLog("evaluating buff " + buff.name + "..");
    if (
      (buff.condition == EquipmentSlot.Melee &&
        action != PlayerInputType.AttackMelee) ||
      (buff.condition == EquipmentSlot.Ranged &&
        action != PlayerInputType.AttackRanged)
    ) {
      if (this.sessionLog)
        this.sessionLog(
          "buff.condition  " +
            buff.condition +
            " doesn't match action " +
            action
        );
      return false;
    }

    if (buff.chance && !Random.flip(buff.chance)) {
      if (this.sessionLog)
        this.sessionLog("buff.chance  " + buff.chance + " failed..");
      return false;
    }

    if (buff.synergy) {
      var synergySet = [];
      if (buff.target == "player") synergySet = this.cardsInPlay;
      else if (buff.target == "opponent" && opponent)
        synergySet = opponent.cardsInPlay;

      for (var card of synergySet) if (card.name == buff.synergy) return true;

      if (this.sessionLog)
        this.sessionLog("buff.synergy  " + buff.synergy + " not satisfied..");
      return false;
    }
    if (this.sessionLog) this.sessionLog("success..");
    return true;
  }

  ignoreDefensiveSummons() {
    if (this.sessionLog) this.sessionLog("checking if direct attack allowed..");
    for (var buff of this.buffs) {
      if (buff.param == "directAttack") {
        if (this.sessionLog)
          this.sessionLog("found ignore defensive summon buff!");
        return true;
      }
    }
    return false;
  }
}
