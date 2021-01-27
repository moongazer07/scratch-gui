/**
 * @license
 * Copyright (c) 2021 Thomas Weber
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/* eslint-disable import/no-commonjs */
/* eslint-disable import/no-nodejs-modules */
/* eslint-disable no-console */

const fs = require('fs');
const childProcess = require('child_process');
const rimraf = require('rimraf');
const pathUtil = require('path');
const postcss = require('postcss');
const postcssVars = require('postcss-simple-vars');
const postcssImport = require('postcss-import');
const addons = require('./addons.json');

const walk = dir => {
    const children = fs.readdirSync(dir);
    const files = [];
    for (const child of children) {
        const path = pathUtil.join(dir, child);
        const stat = fs.statSync(path);
        if (stat.isDirectory()) {
            const childChildren = walk(path);
            for (const childChild of childChildren) {
                files.push(pathUtil.join(child, childChild));
            }
        } else {
            files.push(child);
        }
    }
    return files;
};

rimraf.sync('ScratchAddons');
rimraf.sync('addons');
rimraf.sync('addons-l10n');
rimraf.sync('libraries');
childProcess.execSync('git clone --depth=1 -b tw https://github.com/GarboMuffin/ScratchAddons ScratchAddons');
fs.mkdirSync('addons', {recursive: true});
fs.mkdirSync('addons-l10n', {recursive: true});
fs.mkdirSync('libraries', {recursive: true});

const JS_HEADER = `/**!
 * Imported from SA
 * @license GPLv3.0 (see LICENSE_GPL or https://www.gnu.org/licenses/ for more information)
 */\n\n`;

const includeImportedLibraries = contents => {
    // Parse things like:
    // import { normalizeHex, getHexRegex } from "../../libraries/normalize-color.js";
    // import RateLimiter from "../../libraries/rate-limiter.js";
    const matches = [...contents.matchAll(/import +(?:{.*}|.*) +from +["']\.\.\/\.\.\/libraries\/([\w\d_-]+\.js)["'];/g)];
    for (const match of matches) {
        const libraryFile = match[1];
        const oldLibraryPath = pathUtil.join('ScratchAddons', 'libraries', libraryFile);
        const newLibraryPath = pathUtil.join('libraries', libraryFile);
        const libraryContents = fs.readFileSync(oldLibraryPath, 'utf-8');
        fs.writeFileSync(newLibraryPath, libraryContents);
    }
};

let fixHardcodedClassesCSS = '/* generated by pull.js */\n';
const includeFixedHardcodedClasses = async contents => {
    // Parse things like:
    // FIXCLASS:prompt_ok-button_3QFdD
    const matches = [...contents.matchAll(/FIXCLASS:\s*(([\w]+?)_([\w-]+)_([\w\d-]+))/g)];
    const filesToFix = {};
    for (const match of matches) {
        const [_fullText, generatedClass, originalFile, originalClass, _hash] = match;
        if (!filesToFix[originalFile]) {
            filesToFix[originalFile] = {};
        }
        filesToFix[originalFile][originalClass] = generatedClass;
    }

    for (const cssFile of Object.keys(filesToFix)) {
        const classesToFix = filesToFix[cssFile];
        const cssPath = `../components/${cssFile}/${cssFile}.css`;
        const cssText = fs.readFileSync(cssPath, 'utf8');

        // Use postcss to process imports and variables.
        const result = await postcss([
            postcssImport,
            postcssVars
        ]).process(cssText, {
            from: cssPath
        });
        const root = result.root;
        const nodes = root.nodes;

        nodeLoop:
        for (const node of nodes) {
            if (node.type !== 'rule') {
                continue;
            }

            // Extract all classes used by this rule.
            // Only rules where all classes it selects are also used by this script will be included.
            // (as those are the only ones where we know the generated name)
            const selector = node.selector;
            const allClassesInSelector = [...selector.matchAll(/\.([\w-]+)/g)].map(i => i[1]);
            for (const className of allClassesInSelector) {
                if (!classesToFix[className]) {
                    continue nodeLoop;
                }
            }

            // Convert the normal selectors to the generated selectors.
            let fixedSelector = selector;
            for (const originalClass of Object.keys(classesToFix)) {
                const generatedClass = classesToFix[originalClass];
                const regexp = new RegExp(`\\.${originalClass}(?=\\s|$)`, 'g');
                fixedSelector = fixedSelector.replace(regexp, `.${generatedClass}`);
            }

            // Generate the CSS.
            let css = `${fixedSelector} {`;
            for (const childNode of node.nodes) {
                if (childNode.type !== 'decl') {
                    continue;
                }
                css += `${childNode.prop}:${childNode.value};`;
            }
            css += `}\n`;
            fixHardcodedClassesCSS += css;
        }
    }
};

const includeImports = (folder, contents) => {
    // The first thing we have to do is figure out which files actually need to be loaded.
    // Parse things like:
    // await addon.tab.loadScript(addon.self.lib + "/tinycolor-min.js");
    const matches = [...contents.matchAll(/addon\.self\.lib *\+ *["']\/([\w\d_-]+\.js)["']/g)];
    const dynamicLibraries = [];
    for (const match of matches) {
        const libraryFile = match[1];
        dynamicLibraries.push(libraryFile);
        const oldLibraryPath = pathUtil.join('ScratchAddons', 'libraries', libraryFile);
        const newLibraryPath = pathUtil.join('libraries', libraryFile);
        const libraryContents = fs.readFileSync(oldLibraryPath, 'utf-8');
        fs.writeFileSync(newLibraryPath, libraryContents);
    }
    const dynamicAssets = fs.readdirSync(folder)
        .filter(file => file.endsWith('.svg'));

    // Then we'll generate some JS to import them.
    let header = '/* inserted by pull.js */\n';
    dynamicAssets.forEach((file, index) => {
        header += `import _twAsset${index} from "./${file}";\n`;
    });
    dynamicLibraries.forEach((file, index) => {
        // Load as a file as it will be run through addon.tab.loadScript
        header += `import _twScript${index} from "!file-loader!../../libraries/${file}";\n`;
    });
    header += `const _twGetAsset = (path) => {\n`;
    dynamicAssets.forEach((file, index) => {
        header += `  if (path === "/${file}") return _twAsset${index};\n`;
    });
    dynamicLibraries.forEach((file, index) => {
        header += `  if (path === "/${file}") return _twScript${index};\n`;
    });
    header += '  throw new Error(`Unknown asset: ${path}`);\n';
    header += '};\n';
    header += '\n';

    // And now we reroute everything to use our imports.
    // Parse things like:
    // el.src = addon.self.dir + "/" + name + ".svg";
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  match
    //                           ^^^^^^^^^^^^^^^^^^^  capture group 1
    contents = contents.replace(
        /addon\.self\.(?:dir|lib) *\+ *([^;]+)/g,
        (_fullText, name) => `/* changed by pull.js */ _twGetAsset(${name})`
    );

    return header + contents;
};

(async () => {
    for (const addon of addons) {
        const oldDirectory = pathUtil.join('ScratchAddons', 'addons', addon);
        const newDirectory = pathUtil.join('addons', addon);
        for (const file of walk(oldDirectory)) {
            const oldPath = pathUtil.join(oldDirectory, file);
            const newPath = pathUtil.join(newDirectory, file);
            fs.mkdirSync(pathUtil.dirname(newPath), {recursive: true});
            let contents = fs.readFileSync(oldPath, 'utf-8');

            if (file.endsWith('.js')) {
                includeImportedLibraries(contents);
                await includeFixedHardcodedClasses(contents);
                if (contents.includes('addon.self.dir') || contents.includes('addon.self.lib')) {
                    contents = includeImports(oldDirectory, contents);
                }
            }

            // Add a license notice, unless one already exists.
            if ((file.endsWith('.js') || file.endsWith('.css')) && !contents.includes('@license')) {
                contents = JS_HEADER + contents;
            }

            fs.writeFileSync(newPath, contents);
        }
    }

    const fixCSSPath = 'fix-hardcoded-classes.css';
    fs.writeFileSync(fixCSSPath, fixHardcodedClassesCSS);

    const l10nFiles = fs.readdirSync(pathUtil.join('ScratchAddons', 'addons-l10n'));
    const languages = [];
    for (const file of l10nFiles) {
        const oldDirectory = pathUtil.join('ScratchAddons', 'addons-l10n', file);
        const newDirectory = pathUtil.join('addons-l10n', file);
        if (!fs.statSync(oldDirectory).isDirectory()) {
            continue;
        }
        languages.push(file);
        fs.mkdirSync(newDirectory, {recursive: true});
        for (const addon of addons) {
            const oldFile = pathUtil.join(oldDirectory, `${addon}.json`);
            const newFile = pathUtil.join(newDirectory, `${addon}.json`);
            try {
                const contents = fs.readFileSync(oldFile, 'utf-8');
                // Parse and stringify to minimize
                const parsed = JSON.parse(contents);
                fs.writeFileSync(newFile, JSON.stringify(parsed));
            } catch (e) {
                // Ignore
            }
        }
    }

    const extensionManifestPath = pathUtil.join('ScratchAddons', 'manifest.json');
    const upstreamMetaPath = 'upstream-meta.json';
    const extensionManifest = JSON.parse(fs.readFileSync(extensionManifestPath, 'utf8'));
    const versionName = extensionManifest.version_name;
    fs.writeFileSync(upstreamMetaPath, JSON.stringify({
        version: versionName,
        languages
    }));
})().catch(err => {
    console.error(err);
    process.exit(1);
});
