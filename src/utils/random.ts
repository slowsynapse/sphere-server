export default class Random {
    static flip(chance) {
        return Math.random() < chance ? 1 : 0;
    }

    static range(v1, v2) {
        return v1 + Math.floor(Math.random() * (v2 - v1 + 1));
    }

    static getValue(raw) {

        var v1 = raw;
        var v2;
        if (typeof(raw) == "string") {
            //no checks, if it breaks i want to know about this
            var split = raw.split("d");
            v1 = split[0];
            v2 = split[1];
        }

        if (v2 == null)
            return v1;

        var result = 0;
        for (var i = 0; i < v1; i++) {
            result += Random.range(1, v2);
        }
        return result;
    }
}