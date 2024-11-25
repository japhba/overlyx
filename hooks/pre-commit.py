#!/usr/bin/env python3
"""
Pre-commit hook for handling .tex and .lyx file synchronization.
This script manages the conversion of LyX files to LaTeX before commit.
"""

import os
import sys
from pathlib import Path
from git_processor import BaseProcessor, CommandError, setup_processor, GitContext

class LyX2TeXProcessor(BaseProcessor):
    """
    Processor for converting LyX files to LaTeX before commit.
    """
    def __init__(self, context: GitContext):
        super().__init__(context, 'pre-commit')

    def process_file(self, lyx_file: Path) -> bool:
        """Process a single LyX file"""
        tex_file = lyx_file.with_suffix(".tex")
        
        self.logger.info(f"\nProcessing: {lyx_file.name}")
        
        try:
            # Convert LyX to LaTeX
            self.run_command(f'lyx --export-to latex {tex_file} -f {lyx_file}')
            
            # Process main.tex differently
            if lyx_file.name == "main.lyx":
                self.run_command(
                    f"gawk '/\\\\begin{{document}}/,/\\\\end{{document}}/ "
                    f"{{if (!/\\\\begin{{document}}/ && !/\\\\end{{document}}/ && !/^\\\\include/) print}}' "
                    f"{tex_file} > temp_file.tex"
                )
                os.rename('temp_file.tex', tex_file)
            
            return True
            
        except CommandError as e:
            self.logger.error(f"Error processing {lyx_file.name}: {e}")
            return False

def main():
    # Change to tex directory
    os.chdir(context.tex_dir)

    # Get all LyX files
    lyx_files = [f for f in context.tex_dir.glob("*.lyx") if "temp" not in str(f) and "main" not in str(f)]

    if not lyx_files:
        processor.logger.warning("No .lyx files found to process")
        return

    # Process each file
    success_count = 0
    for lyx_file in lyx_files:
        if processor.process_file(lyx_file):
            success_count += 1

    # Create .commit file to signal post-commit hook
    Path('.commit').touch()

    # Final summary
    total = len(lyx_files)
    processor.logger.info(f"\nProcessing complete: {success_count}/{total} files successful")
    if success_count < total:
        processor.logger.warning("Some files were not processed successfully")
        sys.exit(1)

if __name__ == "__main__":
    context, processor = setup_processor('pre-commit', LyX2TeXProcessor)
    main()