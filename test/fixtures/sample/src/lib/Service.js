import { helper } from '../util.js';

/** Does service things. */
export class Service {
    constructor(name) {
        this.name = name;
    }

    run(value) {
        return helper(value) + this.countdown(value);
    }

    countdown(value) {
        return value > 0 ? this.countdown(value - 1) : 0;
    }
}
