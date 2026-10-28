import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const posix = value => value.split(path.sep).join('/');
const inside = (file, directory) => file === directory || file.startsWith(`${directory}/`);

export function owner(file) {
  if (inside(file, 'src') || inside(file, 'apps/web')) return 'web';
  if (inside(file, 'apps/api')) return 'api';
  if (inside(file, 'packages/contracts')) return 'contracts';
  if (inside(file, 'packages/study-core')) return 'study-core';
}

export function allowed(from, to) {
  if (!from || !to || from === to) return true;
  if (from === 'contracts') return false;
  if (from === 'study-core') return to === 'contracts';
  return to !== 'api' && to !== 'web';
}

export function inspectDocker(text, application, filename = 'Dockerfile') {
  const errors = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!/^\s*(?:COPY|ADD)\s/i.test(line)) continue;
    const instruction = line.trim().replace(/^(?:COPY|ADD)\s+/i, '').replace(/^(?:--[^\s]+\s+)*/, '');
    let tokens;
    if (instruction.startsWith('[')) {
      try { tokens = JSON.parse(instruction); }
      catch { errors.push(`${filename}:${index + 1}: unparseable copy instruction`); continue; }
    } else tokens = instruction.split(/\s+/).map(token => token.replace(/^["']|["']$/g, ''));
    for (const token of tokens.slice(0, -1)) {
      if (typeof token !== 'string' || token.includes('$')) { errors.push(`${filename}:${index + 1}: dynamic copy input requires an audited mapping`); continue; }
      const source = token.replace(/^\/(?:app|repo)\//, '').replace(/^\.\//, '');
      if (/(?:^|\/)\.env(?:\.|$)/.test(source) || /(?:^|\/)data(?:\/|$)/.test(source)) errors.push(`${filename}:${index + 1}: credentials/data must not be copied into an image`);
      if (source === '.' || source === '/') errors.push(`${filename}:${index + 1}: broad copy hides application/credential boundaries`);
      // A sibling's manifest is graph metadata, not application code or an asset.
      if (source === 'apps/api/package.json' || source === 'apps/web/package.json') continue;
      if (!allowed(application, owner(source))) errors.push(`${filename}:${index + 1}: ${application} image copies ${source}`);
      if (application === 'api' && source === 'dist') errors.push(`${filename}:${index + 1}: API image copies legacy Web dist`);
    }
  }
  return errors;
}

const ignored = new Set(['node_modules', 'dist', 'dist-api', '.git', '.turbo']);
function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

/** Resolve using TypeScript, so aliases and type-only imports cannot hide edges. */
export function inspectSource(filename, text, options = {}, root = repository) {
  const relative = posix(path.relative(root, filename));
  const sourceOwner = owner(relative);
  const errors = [];
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const constants = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  function literals(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node)) return literals(constants.get(node.text), seen);
    if (ts.isConditionalExpression(node)) {
      const left = literals(node.whenTrue, seen), right = literals(node.whenFalse, seen);
      return left && right ? [...left, ...right] : null;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') return literals(node.arguments?.[0], seen);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'href') return literals(node.expression, seen);
    return null;
  }
  function fail(node, message) {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    errors.push(`${relative}:${line + 1}: ${message}`);
  }
  function reference(node, specifier) {
    const clean = specifier.replace(/[?#].*$/, '');
    const resolved = ts.resolveModuleName(clean, filename, options, ts.sys).resolvedModule?.resolvedFileName;
    const candidate = resolved ?? (clean.startsWith('.') ? path.resolve(path.dirname(filename), clean)
      : clean.startsWith('/') ? path.join(root, clean) : undefined);
    if (candidate) {
      const real = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
      const target = posix(path.relative(root, real));
      if (!allowed(sourceOwner, owner(target))) fail(node, `forbidden ${sourceOwner} → ${owner(target)}: ${specifier}`);
      if (sourceOwner === 'api' && owner(target) && owner(target) !== 'api' && clean.startsWith('.')) {
        fail(node, `cross-package imports must use workspace exports: ${specifier}`);
      }
    }
    const packageOwner = clean.startsWith('@wangke/study-core') ? 'study-core'
      : clean.startsWith('@wangke/contracts') ? 'contracts'
        : clean.startsWith('@wangke/api') ? 'api' : clean.startsWith('@wangke/web') ? 'web' : undefined;
    if (packageOwner && !allowed(sourceOwner, packageOwner)) fail(node, `forbidden package edge: ${specifier}`);
    if ((sourceOwner === 'study-core' || sourceOwner === 'contracts') && /^(?:node:|react(?:\/|$)|zustand(?:\/|$)|dexie$|better-sqlite3$|fastify$)/.test(clean)) {
      fail(node, `environment-specific shared dependency: ${specifier}`);
    }
  }
  function walk(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      reference(node, node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      reference(node, node.argument.literal.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      || (ts.isPropertyAccessExpression(node.expression) && ['glob', 'resolve'].includes(node.expression.name.text)))) {
      const value = node.arguments[0];
      const values = literals(value);
      if (values) for (const specifier of values) reference(node, specifier);
      else if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        fail(node, 'non-literal module loading requires an explicit audited adapter');
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const value = node.arguments?.[0];
      if (value && ts.isStringLiteralLike(value)) reference(node, value.text);
    } else if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && /^(?:cpSync|cp|copyFileSync|copyFile|readFileSync|readFile)$/.test(node.expression.text))
      || (ts.isPropertyAccessExpression(node.expression) && /^(?:cpSync|cp|copyFileSync|copyFile|readFileSync|readFile)$/.test(node.expression.name.text)))) {
      const values = literals(node.arguments[0]);
      for (const value of values ?? []) {
        reference(node, value);
        const rooted = posix(path.relative(root, path.resolve(root, value)));
        if (!allowed(sourceOwner, owner(rooted))) fail(node, `forbidden filesystem/build input: ${value}`);
      }
    }
    // Shared code may use platform-standard fetch/Blob/URL, never application globals.
    if ((sourceOwner === 'contracts' || sourceOwner === 'study-core') && ts.isIdentifier(node)
      && ['window', 'document', 'localStorage', 'indexedDB', 'navigator', 'process', 'Buffer'].includes(node.text)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      fail(node, `environment capability must be injected: ${node.text}`);
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  return errors;
}

export function audit(root = repository) {
  const errors = [];
  for (const legacy of ['src', 'public', 'index.html', 'vite.config.ts', 'tsconfig.app.json', 'tsconfig.node.json']) {
    if (fs.existsSync(path.join(root, legacy))) errors.push(`Legacy Web root ${legacy} must live exclusively in apps/web`);
  }
  for (const [filename, application] of [['Dockerfile', 'api'], ['infra/docker/web.Dockerfile', 'web']]) {
    const file = path.join(root, filename);
    if (fs.existsSync(file)) errors.push(...inspectDocker(fs.readFileSync(file, 'utf8'), application, filename));
  }
  for (const directory of ['apps/api', 'apps/web', 'src', 'packages/contracts', 'packages/study-core']) {
    const configPath = ts.findConfigFile(path.join(root, directory), ts.sys.fileExists);
    let options = { moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 };
    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      options = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options;
    }
    for (const file of files(path.join(root, directory))) {
      if (/\.(?:[cm]?[jt]sx?)$/.test(file)) errors.push(...inspectSource(file, fs.readFileSync(file, 'utf8'), options, root));
      if (/^tsconfig.*\.json$/.test(path.basename(file))) {
        const config = ts.readConfigFile(file, ts.sys.readFile);
        if (!config.error) {
          const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(file));
          const from = owner(posix(path.relative(root, file)));
          for (const target of Object.values(parsed.options.paths ?? {}).flat()) {
            const resolved = posix(path.relative(root, path.resolve(parsed.options.baseUrl ?? path.dirname(file), target)));
            if (!allowed(from, owner(resolved))) errors.push(`${file}: forbidden alias target ${target}`);
          }
          for (const included of parsed.fileNames) {
            const target = posix(path.relative(root, included));
            if (!allowed(from, owner(target))) errors.push(`${file}: forbidden compilation input ${target}`);
          }
        }
      }
      if (path.basename(file) === 'package.json') {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        const from = owner(posix(path.relative(root, file)));
        for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          const to = name === '@wangke/api' ? 'api' : name === '@wangke/web' ? 'web' : name === '@wangke/study-core' ? 'study-core' : name === '@wangke/contracts' ? 'contracts' : undefined;
          if (!allowed(from, to)) errors.push(`${file}: forbidden dependency ${name}`);
        }
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = audit();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Application/shared source boundaries passed (AST imports, types, dynamic loading and resource URLs).');
}
