import { registerAllProcessors } from '../src/core';
import { collectCoreStrings } from '../src/i18n/coreStrings';

/** Prints every core string that needs a translation, one JSON string per line. */
registerAllProcessors();
for (const s of collectCoreStrings()) console.log(JSON.stringify(s));
