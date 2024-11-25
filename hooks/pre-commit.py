#!/usr/bin/env python3
"""
Pre-commit hook for handling .tex and .lyx file synchronization.
This script manages the conversion of LyX files to LaTeX before commit.
"""

from dataclasses import dataclass
import logging
import os
import subprocess
from pathlib import Path
import sys

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

class LyXProcessor:
    def __init__(self, context: GitContext):
        self.ctx = context
        self.logger = self._setup_logger()
        
    def _setup_logger(self) -> logging.Logger:
        """Configure logging to both file and console"""
        logger = logging.getLogger('pre-commit')
        logger.setLevel(logging.DEBUG)
        
        # Clear existing log file
        self.ctx.log_file.unlink(missing_ok=True)
        
        # File handler
        fh = logging.FileHandler(self.ctx.log_file)
        fh.setLevel(logging.DEBUG)
        
        # Console handler
        ch = logging.StreamHandler()
        ch.setLevel(logging.DEBUG)
        
        # Formatter
        formatter = logging.Formatter('%(asctime)s - %(message)s')
        fh.setFormatter(formatter)
        ch.setFormatter(formatter)
        
        logger.addHandler(fh)
        logger.addHandler(ch)
        
        return logger

    def run_command(self, cmd: str, check: bool = True) -> subprocess.CompletedProcess:
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
            
            if result.stdout:
                self.logger.debug(result.stdout)
            if result.stderr:
                self.logger.debug(result.stderr)
                
            return result
            
        except subprocess.CalledProcessError as e:
            self.logger.error(f"Command failed: {cmd}")
            self.logger.error(f"Error output: {e.stderr}")
            raise CommandError(f"Command failed: {cmd}") from e

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
    # Setup paths
    git_root = Path(subprocess.getoutput('git rev-parse --show-toplevel'))
    tex_dir = git_root if git_root.name.startswith("tex") else git_root / "tex"
    overlyx_dir = Path.home() / "overlyx"
    log_file = tex_dir / "pre-commit.log"

    # Change to tex directory
    os.chdir(tex_dir)

    # Initialize context and processor
    context = GitContext(git_root, tex_dir, overlyx_dir, log_file)
    processor = LyXProcessor(context)

    # Get all LyX files
    lyx_files = list(tex_dir.glob("*.lyx"))

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
    main()