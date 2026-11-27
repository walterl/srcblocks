import { Service } from './lib/Service.js';
import { arrow } from './util.js';

function main() {
    const service = new Service('demo');
    return service.run(arrow(2));
}

main();
