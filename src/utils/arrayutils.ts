export default class ArrayUtils {
    static removeElemFrom(elem, array) {
        var index = array.indexOf(elem);
        if (index >= 0) {
            array.splice(index, 1);
            return true;
        }
        return false;
    }

    static FindMatch<T>(array: T[], key: string, value: T): T {
        for (var elem of array) {
            if (elem[key] == value)
                return elem;
        }
        return null;
    }

    static RemoveMatch<T>(array: T[], key: string, value: T) {
        for (var i = 0; i < array.length; i++) {
            if (array[i][key] == value) {
                array.splice(i, 1);
                break;
            }
        }
    }
}