import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('vendor',{recursive:true});
await build({stdin:{contents:"export {createClient} from '@supabase/supabase-js';",resolveDir:process.cwd(),loader:'js'},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:'vendor/supabase.js'});

await build({entryPoints:['src/native.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:'vendor/native.js'});
