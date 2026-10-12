import { createRequire } from 'node:module';
import { describe, it } from 'vitest';
import { runPgRoutineContract } from './helpers/pgRoutineContract';

if (process.env.DRIZZLE_FUNCTION_TEST_PACKAGE === '1') {
	const require = createRequire(import.meta.url);
	runPgRoutineContract(require('../dist/api.js'));
} else {
	describe.skip('built PostgreSQL routine API', () => {
		it('requires DRIZZLE_FUNCTION_TEST_PACKAGE=1 and a built dist directory', () => {});
	});
}
