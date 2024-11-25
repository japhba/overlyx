#!/usr/bin/env python3
"""
Shared base module for git hooks handling .tex and .lyx file synchronization.
"""

from dataclasses import dataclass
import logging
import subprocess
from pathlib import Path

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

class BaseProcessor:
    def __init__(self, context: GitContext, hook_name: str):
        self.ctx = context
        self.hook_name = hook_name
        self.logger = self._setup_logger()
        
    def _setup_logger(self) -> logging.Logger:
        """Configure logging to both file and console"""
        logger = logging.getLogger(self.hook_name)
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
            self.logger.error(f"Error output: {e.stderr}")
            raise CommandError(f"Command failed: {cmd}") from e

def setup_processor(hook_name: str, processor_class) -> tuple[GitContext, BaseProcessor]:
    """Helper function to setup the context and processor"""
    # Setup paths
    git_root = Path(subprocess.getoutput('git rev-parse --show-toplevel'))
    tex_dir = git_root if git_root.name.startswith("tex") else git_root / "tex"
    overlyx_dir = Path.home() / "overlyx"
    log_file = tex_dir / f"{hook_name}.log"

    # Initialize context and processor
    context = GitContext(git_root, tex_dir, overlyx_dir, log_file)
    processor = processor_class(context)
    
    return context, processor 