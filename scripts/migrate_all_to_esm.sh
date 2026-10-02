#!/bin/bash
# Migration script for Ani-Chan Bot: Convert all files to ES Modules

set -e

echo "=========================================="
echo "Ani-Chan Bot: ES Module Migration"
echo "=========================================="

# Track changes
CHANGED_FILES=0
TOTAL_FILES=0

# Function to convert a single file
convert_file() {
    local file="$1"
    TOTAL_FILES=$((TOTAL_FILES + 1))
    
    # Skip if already has ES module exports
    if grep -q "export default\|export {" "$file" 2>/dev/null; then
        echo "✓ $file - Already ES Module"
        return 0
    fi
    
    # Skip if it's the main index.js (already converted)
    if [[ "$file" == *"src/index.js"* ]]; then
        echo "✓ $file - Already converted"
        return 0
    fi
    
    echo "Processing: $file"
    
    # Create backup
    cp "$file" "$file.backup"
    
    # Use Python script for conversion
    python3 - "$file" << 'PYEOF'
import re
import sys

filepath = sys.argv[1]

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

original = content

# 1. Convert require to import statements
# Collect all requires
requires = []
lines = content.split('\n')

for i, line in enumerate(lines):
    # Destructured: const { a, b } = require('x')
    m = re.match(r'^\s*const\s*\{([^}]+)\}\s*=\s*require\(([^)]+)\)\s*;?\s*$', line.strip())
    if m:
        imports = m.group(1).strip()
        source = m.group(2).strip().strip("'\"")
        requires.append(('destructured', imports, source, i))
        continue
    
    # Default: const x = require('y')
    m = re.match(r'^\s*const\s+(\w+)\s*=\s*require\(([^)]+)\)\s*;?\s*$', line.strip())
    if m:
        var_name = m.group(1)
        source = m.group(2).strip().strip("'\"")
        requires.append(('default', var_name, source, i))
        continue

# Sort by line number and remove duplicates
requires.sort(key=lambda x: x[3])
unique_requires = []
seen = set()
for r in requires:
    key = (r[0], r[1], r[2])
    if key not in seen:
        seen.add(key)
        unique_requires.append(r)

# Build import statements
import_lines = []
for req_type, name, source, _ in unique_requires:
    # Fix relative paths
    if source.startswith('../'):
        source = './' + source[3:] if source.startswith('../../') else source[1:]
    
    # Add .js extension for local files
    if source.startswith('./') or source.startswith('../'):
        if not source.endswith('.js'):
            source = source + '.js'
    
    if req_type == 'destructured':
        import_lines.append(f"import {{ {name} }} from '{source}';")
    else:
        import_lines.append(f"import {name} from '{source}';")

# Remove require lines
new_lines = []
require_line_indices = set(idx for _, _, _, idx in unique_requires)

for i, line in enumerate(lines):
    if i in require_line_indices:
        continue
    new_lines.append(line)

# Replace module.exports
content = '\n'.join(new_lines)
content = re.sub(r'module\.exports\s*=', 'export default ', content)
content = re.sub(r'module\.exports\.', 'export default .', content)

# Replace require('node_module') with import
# Handle common Node.js modules
node_modules = ['crypto', 'mongoose', 'path', 'fs', 'os', 'axios', 'fluent-ffmpeg', 
               'child_process', 'https', 'http', 'url', 'util', 'events', 'buffer']

for mod in node_modules:
    pattern = rf"require\(['\"]{mod}['\"]\)"
    if re.search(pattern, content):
        # Add import
        import_line = f"import {mod} from '{mod}';"
        lines = content.split('\n')
        insert_pos = 0
        for j, l in enumerate(lines):
            if l.strip() and not l.strip().startswith('#!') and not l.strip().startswith('//'):
                insert_pos = j
                break
        lines.insert(insert_pos, import_line)
        content = '\n'.join(lines)
        
        # Replace all occurrences
        content = re.sub(pattern, mod, content)

# Replace require('whatsapp-web.js').MessageMedia
content = re.sub(
    r"require\(['\"]whatsapp-web\.js['\"]\)\.MessageMedia",
    "{ MessageMedia } from '../services/media.js'",
    content
)

# Remove standalone MessageMedia requires
content = re.sub(
    r"const\s+\{?\s*MessageMedia\s*\}?\s*=\s*require\(['\"]whatsapp-web\.js['\"]\)\s*;?",
    "",
    content
)

# Clean up multiple blank lines
content = re.sub(r'\n{3,}', '\n\n', content)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"Converted {filepath}")
PYEOF
    
    # Verify syntax
    if node -c "$file" 2>/dev/null; then
        rm -f "$file.backup"
        CHANGED_FILES=$((CHANGED_FILES + 1))
        echo "  ✅ $file converted successfully"
    else
        echo "  ❌ $file has syntax errors, restoring backup"
        mv "$file.backup" "$file"
    fi
}

# Export functions for use in scripts
export -f convert_file

# Main migration
echo ""
echo "Converting files..."
echo ""

# Find all JS files in src
while IFS= read -r -d '' file; do
    convert_file "$file"
done < <(find src -name "*.js" -type f ! -path "*/node_modules/*" -print0 | sort -z)

echo ""
echo "=========================================="
echo "Migration Summary:"
echo "  Total files: $TOTAL_FILES"
echo "  Converted: $CHANGED_FILES"
echo "=========================================="
