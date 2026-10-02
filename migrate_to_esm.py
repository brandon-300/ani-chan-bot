#!/usr/bin/env python3
"""
Migration script to convert CommonJS modules to ES Modules
for the Ani-Chan Bot Baileys migration.
"""

import os
import re
import sys
from pathlib import Path

# Directories to process
COMMANDS_DIR = Path("src/commands")
MODELS_DIR = Path("src/models")
UTILS_DIR = Path("src/utils")
SERVICES_DIR = Path("src/services")
MIDDLEWARE_DIR = Path("src/middleware")
CLIENT_DIR = Path("src/client")
CONFIG_DIR = Path("src/config")

def convert_file(filepath):
    """Convert a single CommonJS file to ES Module."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    
    # Track if we're in a string to avoid replacing require inside strings
    in_string = False
    string_char = None
    
    # First pass: Convert require() to import statements
    # We need to collect all requires first, then add imports at the top
    
    requires = []
    lines = content.split('\n')
    new_lines = []
    import_block = []
    
    for line in lines:
        # Skip shebang and empty lines at the top
        if line.strip().startswith('#!') or not line.strip():
            new_lines.append(line)
            continue
        
        # Check for require statements
        require_match = re.match(r'^\s*(const|let|var)\s+', line)
        if require_match:
            # Check for destructured import
            destructured_match = re.match(
                r'^\s*(const|let|var)\s+\{([^}]+)\}\s*=\s*require\(([^)]+)\)\s*;?$',
                line.strip()
            )
            if destructured_match:
                var_type, imports, source = destructured_match.groups()
                source = source.strip('"\'')
                requires.append((var_type, imports, source, True))
                continue
            
            # Check for default import
            default_match = re.match(
                r'^\s*(const|let|var)\s+(\w+)\s*=\s*require\(([^)]+)\)\s*;?$',
                line.strip()
            )
            if default_match:
                var_type, var_name, source = default_match.groups()
                source = source.strip('"\'')
                requires.append((var_type, var_name, source, False))
                continue
        
        # Check for module.exports
        if 'module.exports' in line:
            # Replace module.exports with export default
            line = line.replace('module.exports =', 'export default')
            line = line.replace('module.exports.', 'export default .')
        
        new_lines.append(line)
    
    # Now build the import block
    if requires:
        for var_type, name_or_imports, source, is_destructured in requires:
            # Fix relative paths
            if source.startswith('../'):
                source = source[1:]  # Remove one ../
            elif source.startswith('./'):
                pass  # Already correct
            
            # Add .js extension if it's a local file
            if source.startswith('./') or source.startswith('../'):
                if not source.endswith('.js'):
                    source = source + '.js'
            
            if is_destructured:
                # import { a, b } from 'source'
                import_line = f"import {{ {name_or_imports} }} from '{source}';".replace(' ', '')
            else:
                # import name from 'source'
                import_line = f"import {name_or_imports} from '{source}';"
            
            import_block.append(import_line)
        
        # Find where to insert imports (after any existing imports or shebang)
        insert_idx = 0
        for i, line in enumerate(new_lines):
            if line.strip().startswith('import '):
                insert_idx = i + 1
            elif line.strip() and not line.strip().startswith('#!') and not line.strip().startswith('//'):
                break
        
        # Insert import block
        new_lines[insert_idx:insert_idx] = import_block
    
    # Second pass: Replace MessageMedia from whatsapp-web.js
    content = '\n'.join(new_lines)
    
    # Replace whatsapp-web.js MessageMedia with our own
    content = re.sub(
        r"require\(['\"]whatsapp-web\.js['\"]\)\.MessageMedia",
        "{ MessageMedia } from '../services/media.js'",
        content
    )
    content = re.sub(
        r"const\s+\{?\s*MessageMedia\s*\}?\s*=\s*require\(['\"]whatsapp-web\.js['\"]\)",
        "",
        content
    )
    
    # Add import for MessageMedia if it was used
    if 'MessageMedia' in content and "from '../services/media.js'" not in content:
        # Find a good place to add it
        if "from '../services/media.js'" not in content:
            # Add it near the top with other imports
            lines = content.split('\n')
            for i, line in enumerate(lines):
                if line.strip().startswith('import ') and 'MessageMedia' not in line:
                    lines.insert(i + 1, "import { MessageMedia } from '../services/media.js';")
                    content = '\n'.join(lines)
                    break
    
    # Replace require('crypto'), require('mongoose'), etc. with imports
    node_builtins = {
        'crypto': True,
        'mongoose': True,
        'path': True,
        'fs': True,
        'os': True,
        'axios': True,
        'ffmpeg': True,
        'fluent-ffmpeg': True,
        'child_process': True,
    }
    
    for module in node_builtins:
        pattern = rf"require\(['\"]{module}['\"]\)"
        if re.search(pattern, content):
            # Add import at top
            import_line = f"import {module} from '{module}';"
            lines = content.split('\n')
            insert_pos = 0
            for i, line in enumerate(lines):
                if line.strip() and not line.strip().startswith('#!') and not line.strip().startswith('//'):
                    insert_pos = i
                    break
            lines.insert(insert_pos, import_line)
            content = '\n'.join(lines)
            
            # Remove the require
            content = re.sub(pattern, module, content)
    
    return content


def process_directory(directory):
    """Process all JS files in a directory."""
    for filepath in directory.rglob('*.js'):
        if filepath.name.endswith('.backup'):
            continue
        
        print(f"Processing: {filepath}")
        try:
            new_content = convert_file(filepath)
            
            # Write to file
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            print(f"  ✓ Converted {filepath}")
        except Exception as e:
            print(f"  ✗ Error with {filepath}: {e}")
            import traceback
            traceback.print_exc()


def main():
    print("=" * 60)
    print("Ani-Chan Bot: CommonJS to ES Module Migration")
    print("=" * 60)
    
    directories = [
        COMMANDS_DIR,
        MODELS_DIR,
        UTILS_DIR,
        SERVICES_DIR,
        MIDDLEWARE_DIR,
        CLIENT_DIR,
        CONFIG_DIR,
    ]
    
    for directory in directories:
        if directory.exists():
            print(f"\nProcessing {directory}...")
            process_directory(directory)
    
    print("\n" + "=" * 60)
    print("Migration complete!")
    print("=" * 60)


if __name__ == '__main__':
    main()
