/**
 * Compile this project's TypeScript with tsc instead of esbuild, for this
 * vitest project only.
 *
 * Vitest transforms TypeScript with esbuild, and esbuild does not implement
 * `emitDecoratorMetadata` -- it is a documented, permanent limitation, not a
 * missing flag. The consequence is not subtle but it is very easy to
 * misdiagnose: `design:paramtypes` is simply absent on every class, so Nest's
 * injector sees a controller with no constructor types and reports
 *
 *   Nest can't resolve dependencies of the SheetsController (?, +, BullQueue_extract)
 *
 * which reads like a broken module import. It is not. Nothing in src/ is wrong;
 * the file the injector was handed had the metadata compiled out of it. This is
 * why every existing test constructs its services with `new` -- hand-wiring is
 * the only thing that works under esbuild, and it is also the reason no test in
 * this repo has ever gone through a guard, a pipe or a route.
 *
 * So the http project runs the sources through the TypeScript compiler that
 * `nest build` uses, with the project's own tsconfig, and changes exactly one
 * option: module output becomes ESM, because Vite's module graph is ESM. Reusing
 * the real compilerOptions matters -- `target` and `useDefineForClassFields`
 * decide whether a DTO's undecorated field exists as an own property at
 * runtime, which is precisely the kind of difference that would make these
 * tests agree with a build nobody ships.
 *
 * The alternative is a devDependency on @swc/core plus unplugin-swc. That is the
 * usual answer and it is faster; it is not obviously worth adding a compiler to
 * the tree when the tree already contains one.
 */
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

const ROOT = resolve(__dirname, '../..');

function projectOptions(): ts.CompilerOptions {
  const path = resolve(ROOT, 'tsconfig.json');
  const raw = ts.readConfigFile(path, ts.sys.readFile);
  if (raw.error) {
    throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, ' '));
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(path));
  return {
    ...parsed.options,
    // Vite links modules by ESM import, so CommonJS output would leave every
    // `import` unresolved and every export undefined.
    module: ts.ModuleKind.ESNext,
    // transpileModule is per file and has no program, so nothing here may
    // depend on cross-file type information.
    isolatedModules: true,
    sourceMap: true,
    inlineSources: true,
    declaration: false,
    declarationMap: false,
    incremental: false,
    composite: false,
    // Emit is per-file and in memory; an outDir would only confuse the paths in
    // the source map.
    outDir: undefined,
    tsBuildInfoFile: undefined,
  };
}

export function decoratorMetadata(): Plugin {
  const options = projectOptions();
  return {
    name: 'nest-decorator-metadata',
    // Ahead of Vite's own esbuild transform, which would otherwise get the
    // TypeScript first and strip the metadata before tsc ever sees it.
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return null;
      if (file.includes('node_modules')) return null;

      const out = ts.transpileModule(code, { fileName: file, compilerOptions: options });
      return {
        code: out.outputText,
        map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null,
      };
    },
  };
}
