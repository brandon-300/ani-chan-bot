/**
 * ES Module Migration Script
 * Converts CommonJS files to ES Modules for Ani-Chan Bot
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '../src');

// Track statistics
let totalFiles = 0;
let convertedFiles = 0;
let skippedFiles = 0;
let errorFiles = 0;

/**
 * Convert a single file from CommonJS to ES Module
 */
function convertFile(filePath) {
    totalFiles++;
    
    try {
        let content = readFileSync(filePath, 'utf-8');
        const originalContent = content;
        
        // Skip if already ES Module
        if (content.includes('export default') || content.includes('export {')) {
            skippedFiles++;
            console.log(`✓ ${relative(SRC_DIR, filePath)} - Already ES Module`);
            return false;
        }
        
        // Skip if it's the main index.js (already converted)
        if (filePath.includes('/src/index.js')) {
            skippedFiles++;
            console.log(`✓ ${relative(SRC_DIR, filePath)} - Already converted`);
            return false;
        }
        
        // 1. Collect all require statements
        const requires = [];
        const lines = content.split('\n');
        
        // Patterns for require statements
        const destructuredReq = /^\s*const\s*\{([^}]+)\}\s*=\s*require\((['"])(.+)\2\)\s*;?\s*$/;
        const defaultReq = /^\s*const\s+(\w+)\s*=\s*require\((['"])(.+)\2\)\s*;?\s*$/;
        const simpleReq = /^\s*const\s+(\w+)\s*=\s*require\((['"])(.+)\2\)\s*$/;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            let match;
            
            // Match destructured imports: const { a, b } = require('x')
            if (match = line.match(destructuredReq)) {
                const imports = match[1].trim();
                const quote = match[2];
                let source = match[3];
                requires.push({ type: 'destructured', imports, source, quote, line: i });
                continue;
            }
            
            // Match default imports: const x = require('y')
            if (match = line.match(defaultReq)) {
                const varName = match[1];
                const quote = match[2];
                let source = match[3];
                requires.push({ type: 'default', varName, source, quote, line: i });
                continue;
            }
            
            // Match without semicolon
            if (match = line.match(simpleReq)) {
                const varName = match[1];
                const quote = match[2];
                let source = match[3];
                requires.push({ type: 'default', varName, source, quote, line: i });
            }
        }
        
        // 2. Build import statements
        const importStatements = new Set();
        const requireLineNumbers = new Set();
        
        for (const req of requires) {
            requireLineNumbers.add(req.line);
            
            let source = req.source;
            
            // Fix relative paths
            if (source.startsWith('../')) {
                // Count how many ../ and adjust
                const levels = (source.match(/\.\.\//g) || []).length;
                source = './' + '../'.repeat(levels - 1) + source.substring(levels * 3);
            }
            
            // Add .js extension for local files
            if (source.startsWith('./') || source.startsWith('../')) {
                if (!source.endsWith('.js')) {
                    source = source + '.js';
                }
            }
            
            // Handle whatsapp-web.js MessageMedia
            if (source === 'whatsapp-web.js' && req.type === 'destructured' && req.imports.includes('MessageMedia')) {
                source = '../services/media.js';
            }
            
            // Build import statement
            if (req.type === 'destructured') {
                importStatements.add(`import { ${req.imports} } from '${source}';`);
            } else {
                importStatements.add(`import ${req.varName} from '${source}';`);
            }
        }
        
        // 3. Remove require statements
        const newLines = lines.filter((line, idx) => !requireLineNumbers.has(idx));
        
        // 4. Replace module.exports
        let newContent = newLines.join('\n');
        newContent = newContent.replace(/module\.exports\s*=/g, 'export default ');
        newContent = newContent.replace(/module\.exports\./g, 'export default .');
        
        // 5. Add imports at the top
        const importLines = Array.from(importStatements).sort();
        
        // Find position to insert imports (after shebang and comments, before first code line)
        let insertIndex = 0;
        for (let i = 0; i < newLines.length; i++) {
            const line = newLines[i].trim();
            if (line && !line.startsWith('#!') && !line.startsWith('//') && !line.startsWith('/*')) {
                insertIndex = i;
                break;
            }
            insertIndex = i + 1;
        }
        
        // Insert import statements
        newLines.splice(insertIndex, 0, ...importLines);
        newContent = newLines.join('\n');
        
        // 6. Handle Node.js built-in modules
        const nodeModules = ['crypto', 'mongoose', 'path', 'fs', 'os', 'axios', 
                          'fluent-ffmpeg', 'child_process', 'https', 'http', 'url', 
                          'util', 'events', 'buffer', 'querystring', 'stream'];
        
        for (const mod of nodeModules) {
            const pattern = new RegExp(`require\(['"]${mod}['"]\)`, 'g');
            if (pattern.test(newContent)) {
                // Add import if not already present
                const importStmt = `import ${mod} from '${mod}';`;
                if (!newContent.includes(importStmt)) {
                    const lines = newContent.split('\n');
                    let insertPos = 0;
                    for (let i = 0; i < lines.length; i++) {
                        const l = lines[i].trim();
                        if (l && !l.startsWith('#!') && !l.startsWith('//') && !l.startsWith('/*')) {
                            insertPos = i;
                            break;
                        }
                        insertPos = i + 1;
                    }
                    lines.splice(insertPos, 0, importStmt);
                    newContent = lines.join('\n');
                }
                
                // Replace require with the module name
                newContent = newContent.replace(pattern, mod);
            }
        }
        
        // 7. Clean up
        newContent = newContent.replace(/\n{3,}/g, '\n\n');
        newContent = newContent.replace(/\n\n\n+/g, '\n\n');
        
        // Only write if content changed
        if (newContent !== originalContent) {
            writeFileSync(filePath, newContent, 'utf-8');
            convertedFiles++;
            console.log(`✅ ${relative(SRC_DIR, filePath)}`);
            return true;
        } else {
            skippedFiles++;
            console.log(`✓ ${relative(SRC_DIR, filePath)} - No changes needed`);
            return false;
        }
        
    } catch (error) {
        errorFiles++;
        console.error(`❌ ${relative(SRC_DIR, filePath)} - Error: ${error.message}`);
        return false;
    }
}

/**
 * Walk through directory and convert all JS files
 */
function walkDirectory(dirPath) {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
            walkDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            convertFile(fullPath);
        }
    }
}

/**
 * Main function
 */
function main() {
    console.log('='.repeat(60));
    console.log('Ani-Chan Bot: CommonJS to ES Module Migration');
    console.log('='.repeat(60));
    console.log('');
    
    // Walk through src directory
    walkDirectory(SRC_DIR);
    
    console.log('');
    console.log('='.repeat(60));
    console.log('Migration Summary:');
    console.log(`  Total files processed: ${totalFiles}`);
    console.log(`  Files converted: ${convertedFiles}`);
    console.log(`  Files skipped: ${skippedFiles}`);
    console.log(`  Files with errors: ${errorFiles}`);
    console.log('='.repeat(60));
}

main();
