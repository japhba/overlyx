from functools import partial
import glob
import subprocess
import os
import time
from pathlib import Path

# Change the current working directory to 'tex' if necessary

GIT_DIR = Path(subprocess.run('git rev-parse --show-toplevel', capture_output=True, text=True, shell=True).stdout.strip())

if not str(GIT_DIR.parts[-1]).startswith("tex"):
    GIT_DIR = GIT_DIR / "tex"
    os.chdir(GIT_DIR)

OVERLYX_DIR = Path.home() / "overlyx"

# log_file = OVERLYX_DIR / "hooks/post-merge.log"
log_file = GIT_DIR / "post-merge.log"
os.remove(log_file) if os.path.exists(log_file) else None

# create log file with pathlib
Path(log_file).touch()

def print_and_log(log_file, message):
    print(message)
    with open(log_file, 'a') as file:
        file.write(message + '\n\n')

print_and_log = partial(print_and_log, log_file)

print_and_log(f"{OVERLYX_DIR}")
print_and_log(f"{GIT_DIR}")
print_and_log(f"cwd: {os.getcwd()}")


def run(cmd, check=True, shell=True):
    with open(log_file, 'a') as file:
        process = subprocess.run(cmd, shell=shell, text=True, stdout=file, stderr=file)        
        if check and process.returncode != 0:
            print_and_log(f"Command failed with error. Check {log_file}.")
            print(process.stdout)
            print(process.stderr)
            if not check == "catch":
                raise subprocess.CalledProcessError(process.returncode, cmd)
            else:
                return process
    return process

def is_git_merging():
    # Run the git command to check if MERGE_HEAD exists
    result = subprocess.run('git rev-parse --verify MERGE_HEAD', shell=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 128 and "fatal" in result.stderr.strip():
        return False
    else:
        return True


all_files = list(GIT_DIR.glob("*.tex"))


for filename_tex in all_files:
    if ("temp" in str(filename_tex)):
        continue

    filename_lyx = Path(filename_tex).with_suffix(".lyx")
    if not filename_lyx.exists():
        print_and_log(f"Lyx file not found for {filename_tex}. Skipping...")
        continue

    try:
        print_and_log(f"Loop is at {filename_lyx}...")
        run(f'git status', )
        run(f'git add {filename_lyx} -v', )
        run(f'git commit -v --allow-empty -m "[hook] pre-hook our {filename_lyx.name}" --no-verify')  # head2

        run(f'lyx --export-to latex {filename_tex} -f {filename_lyx}')

        # main special treatment
        if not ("main.tex" in str(filename_tex)):
            gawk_command = r"gawk '/\\begin\{document\}/,/\\end\{document\}/ {if (!/\\begin\{document\}/ && !/\\end\{document\}/ && !/^\\include/) print}' "
            run(gawk_command + f'{filename_tex} > temp_file.tex', )
            os.rename('temp_file.tex', filename_tex)

        run(f'git add {filename_tex}', )
        run(f'git commit -v --allow-empty -m "[hook] commit our {filename_tex.name}" --no-verify')  # head1
        run('git stash -u', )
        run('git fetch', )
        run(f'touch {OVERLYX_DIR}/.disable_hooks')
        
        print_and_log(f"Merge {filename_tex.name}...")

        # -X theirs to resolve conflict by keeping the remote version
        run('git merge -vvvvv --no-ff --no-verify origin/master -m "[hook] Merge origin into local"', check="catch")  # head0

        run(f'rm {OVERLYX_DIR}/.disable_hooks')

        # Detect if a merge conflict has occurred
        if is_git_merging():
            print_and_log("! Merge conflict detected. Please resolve the conflict and commit. Waiting for resolution...")
            while is_git_merging():
                time.sleep(1)  # Check every 1 seconds
            print_and_log("Merge conflict resolved. Continuing...")

        run('git stash pop', check=False)
        run(f'tex2lyx -f {filename_tex}', )

        run('git reset --soft HEAD@{2}', )
        print_and_log(f"merged .tex differs from upstream by:")
        run(f"git diff origin/master {filename_tex}")
        run(f'git checkout origin/master -- {filename_tex}')  # checkout tex at remote version
        print_and_log(f"Exit code 0: {filename_lyx}.")

    except subprocess.CalledProcessError as e:
        print_and_log(f"Error in subprocess: {e}")
        raise SystemExit

print_and_log("All post-merge processing completed.")