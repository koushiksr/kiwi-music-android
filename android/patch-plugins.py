import glob
import os
import re
import xml.etree.ElementTree as ET

pub_cache = os.path.expanduser('~/.pub-cache')
print(f"Scanning {pub_cache} for legacy plugin build.gradle files...")

for f in glob.glob(f'{pub_cache}/**/android/build.gradle', recursive=True):
    try:
        with open(f, 'r') as fp:
            content = fp.read()
        modified = False

        # 1. Inject missing namespace if not present
        if 'android {' in content and 'namespace' not in content:
            manifest_path = os.path.join(os.path.dirname(f), 'src/main/AndroidManifest.xml')
            pkg = None
            if os.path.exists(manifest_path):
                try:
                    tree = ET.parse(manifest_path)
                    pkg = tree.getroot().attrib.get('package')
                except Exception:
                    pass
            if not pkg:
                if 'on_audio_query' in f:
                    pkg = 'com.lucasjosino.on_audio_query'
                else:
                    pkg = 'com.plugin.legacy'
            content = content.replace('android {', f'android {{\n    namespace "{pkg}"')
            modified = True
            print(f'Patched namespace "{pkg}" in: {f}')

        # 2. Align JVM target to Java 17 for on_audio_query_android
        if 'on_audio_query_android' in f:
            jvm_block = '''
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }'''
            if 'compileOptions' in content:
                content = re.sub(r'compileOptions\s*\{[^}]*\}', '', content)
            if 'kotlinOptions' in content:
                content = re.sub(r'kotlinOptions\s*\{[^}]*\}', '', content)
            content = content.replace('android {', f'android {{{jvm_block}')
            modified = True
            print(f'Patched JVM 17 options in: {f}')

        if modified:
            with open(f, 'w') as fp:
                fp.write(content)
    except Exception as e:
        print(f'Notice on {f}: {e}')

print("Plugin patching completed successfully.")
