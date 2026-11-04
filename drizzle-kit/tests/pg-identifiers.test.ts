import * as api from '../src/api';
import { schemaToTypeScript } from '../src/introspect-pg';
import { runPgIdentifierContract } from './helpers/pgIdentifierContract';

runPgIdentifierContract(api, (snapshot) => schemaToTypeScript(snapshot, 'preserve').file);
