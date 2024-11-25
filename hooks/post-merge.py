#!/usr/bin/env python3
"""
Post-merge hook for handling .tex and .lyx file synchronization.
This script manages the conversion and merging of LaTeX and LyX files.
"""

from dataclasses import dataclass
from functools import partial
import glob
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional, List, Tuple

@dataclass
class GitContext:
    """Holds git-related paths and context"""
    root_dir: Path
    tex_dir: Path
    overlyx_dir: Path
    log_file: Path

class CommandError(Exception):
    """Custom exception for command execution failures"""
    pass

class GitProcessor:
    def __init__(self, context: GitContext):
        self.ctx = context
        self.logger = self._setup_logger()
        
    def _setup_logger(self) -> logging.Logger:
        """Configure logging to both file and console"""
        logger = logging.getLogger('post-merge')
        logger.setLevel(logging.DEBUG)  # TODO: change to INFO
        
        # Clear existing log file
        self.ctx.log_file.unlink(missing_ok=True)
        
        # File handler
        fh = logging.FileHandler(self.ctx.log_file)
        fh.setLevel(logging.DEBUG)
        
        # Console handler
        ch = logging.StreamHandler()
        ch.setLevel(logging.DEBUG)  # TODO: change to INFO
        
        # Formatter
        formatter = logging.Formatter('%(asctime)s - %(message)s')
        fh.setFormatter(formatter)
        ch.setFormatter(formatter)
        
        logger.addHandler(fh)
        logger.addHandler(ch)
        
        return logger

    def run_command(self, cmd: str, check: bool = True, silent: bool = False) -> subprocess.CompletedProcess:
        """Execute a shell command with proper logging and error handling"""
        self.logger.debug(f"Executing: {cmd}")
        
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                text=True,
                capture_output=True,
                check=check
            )
            
            if not silent:
                if result.stdout:
                    self.logger.debug(result.stdout)
                if result.stderr:
                    self.logger.debug(result.stderr)
                    
            return result
            
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Command failed: {cmd}")
            self.logger.error(f"Error output: {e.stderr} {e.stdout}")
            raise CommandError(f"Command failed: {cmd}") from e

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
    # Setup paths
    git_root = Path(subprocess.getoutput('git rev-parse --show-toplevel'))
    tex_dir = git_root if git_root.name.startswith("tex") else git_root / "tex"
    overlyx_dir = Path.home() / "overlyx"
    log_file = tex_dir / "post-merge.log"

    # Change to tex directory
    os.chdir(tex_dir)

    # Initialize context and processor
    context = GitContext(git_root, tex_dir, overlyx_dir, log_file)
    processor = GitProcessor(context)

    # Get all tex files
    tex_files = [f for f in tex_dir.glob("*.tex") if "temp" not in str(f) and "main" not in str(f)]

    if not tex_files:
        processor.logger.warning("[OverLyX] No .tex files found to process")
        return

    # Process each file
    success_count = 0
    for tex_file in tex_files:
        if processor.process_file(tex_file):
            success_count += 1

    # Final summary
    total = len(tex_files)
    processor.logger.info(f"\n[OverLyX] Processing complete: {success_count}/{total} files successful")
    if success_count < total:
        processor.logger.warning("[OverLyX] Some files were not processed successfully")
        sys.exit(1)

if __name__ == "__main__":
    main()