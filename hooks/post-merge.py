#!/usr/bin/env python3
"""
Post-merge hook for handling .tex and .lyx file synchronization.
This script manages the conversion and merging of LaTeX and LyX files.
"""

import os
import sys
from pathlib import Path
from git_processor import BaseProcessor, CommandError, setup_processor, GitContext

class TeX2LyXProcessor(BaseProcessor):
    """
    Processor for converting LaTeX to LyX files after a merge from remote Overleaf.
    """
    def __init__(self, context: GitContext):
        super().__init__(context, 'post-merge')

    def is_git_merging(self) -> bool:
        """Check if git is currently in a merging state"""
        result = self.run_command('git rev-parse --verify MERGE_HEAD', check=False, silent=True)
        return result.returncode == 0

    def handle_merge_conflict(self, filename: Path) -> bool:
        """Handle merge conflicts automatically by accepting remote version"""
        self.logger.warning(f"Merge conflict detected in {filename}. Accepting remote version...")
        self.run_command('git checkout --theirs .')
        self.run_command('git add .')
        self.run_command('git commit -m "[hook] Accept remote version"')
        return True
    def process_file(self, tex_file: Path) -> bool:
        """Process a single tex file"""
        lyx_file = tex_file.with_suffix(".lyx")
        
        self.logger.info(f"\nProcessing: {tex_file.name}")
        
        # Check for lyx file existence
        if not lyx_file.exists():
            self.logger.warning(f"LyX file not found: {lyx_file.name}")
            try:
                self.run_command(f'tex2lyx -f {tex_file}')
                self.logger.info(f"Created {lyx_file.name}")
            except CommandError:
                self.logger.error(f"Failed to create {lyx_file.name}")
                return False

        try:
            # Backup current work
            self.run_command(f'git add {lyx_file}')
            self.run_command(f'git commit --allow-empty -m "[hook] Backup {lyx_file.name}" --no-verify')

            # Convert LyX to LaTeX
            self.run_command(f'lyx --export-to latex {tex_file} -f {lyx_file}')

            # Process non-main tex files
            if tex_file.name != "main.tex":
                self.run_command(
                    f"gawk '/\\\\begin{{document}}/,/\\\\end{{document}}/ "
                    f"{{if (!/\\\\begin{{document}}/ && !/\\\\end{{document}}/ && !/^\\\\include/) print}}' "
                    f"{tex_file} > temp_file.tex"
                )
                os.rename('temp_file.tex', tex_file)
            # Prepare for merge
            self.run_command(f'git add {tex_file}')
            self.run_command(f'git commit --allow-empty -m "[hook] Pre-merge {tex_file.name}" --no-verify')
            self.run_command('git stash -u')  # Stash all changes before the pull
            self.run_command('git fetch')

            # Disable other hooks during merge
            disable_hooks = self.ctx.overlyx_dir / ".disable_hooks"
            disable_hooks.touch()

            try:
                self.logger.info(f"Merging {tex_file.name}...")
                self.run_command('git merge -v --no-ff --no-verify origin/master -m "[hook] Merge origin into local"')

                # Handle any merge conflicts
                if self.is_git_merging():
                    if not self.handle_merge_conflict(tex_file):
                        return False

                # Re-apply stashed changes from before the pull and convert back to LyX
                self.run_command('git stash pop', check=False)
                self.run_command(f'tex2lyx -f {tex_file}')

                # Reset and checkout remote version
                self.logger.info("Resetting Git HEAD to remote version...")
                self.run_command('git reset --soft HEAD@{2}')

                self.logger.info("Checking differences from upstream <-> local...")
                self.run_command(f"git diff origin/master {tex_file}")
                self.run_command(f'git checkout origin/master -- {tex_file}')

                self.logger.info(f"Successfully processed {tex_file.name}")
                return True

            finally:
                # Always remove disable_hooks file
                disable_hooks.unlink(missing_ok=True)
        except CommandError as e:
            self.logger.error(f"Error processing {tex_file.name}: {e}")
            return False
        

def main():
    # Change to tex directory
    os.chdir(context.tex_dir)

    # Get all tex files
    tex_files = [f for f in context.tex_dir.glob("*.tex") if "temp" not in str(f) and "main" not in str(f)]

    if not tex_files:
        processor.logger.warning("No .tex files found to process")
        return

    # Process each file
    success_count = 0
    for tex_file in tex_files:
        if processor.process_file(tex_file):
            success_count += 1

    # Final summary
    total = len(tex_files)
    processor.logger.info(f"\nProcessing complete: {success_count}/{total} files successful")
    if success_count < total:
        processor.logger.warning("Some files were not processed successfully")
        sys.exit(1)

if __name__ == "__main__":
    context, processor = setup_processor('post-merge', TeX2LyXProcessor)
    main()
