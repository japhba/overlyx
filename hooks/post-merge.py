from functools import partial
import glob
import subprocess
import os
import time

# Change the current working directory to 'tex' if necessary

GIT_DIR = subprocess.run('git rev-parse --show-toplevel', capture_output=True, text=True, shell=True).stdout.strip()
OVERLYX_DIR = "~/overlyx"

log_file = 'post-merge.log'
os.remove(log_file) if os.path.exists(log_file) else None

def print_and_log(log_file, message):
    print(message)
    with open(log_file, 'a') as file:
        file.write(message + '\n')

print_and_log = partial(print_and_log, log_file)


def run(cmd, check=False, shell=True):
    with open(log_file, 'a') as file:
        process = subprocess.run(cmd, shell=shell, text=True, stdout=file, stderr=subprocess.STDOUT)        
        if check and process.returncode != 0:
            print_and_log(f"Command failed with error. Check {log_file}.")
            raise subprocess.CalledProcessError(process.returncode, cmd)
    return process

def is_git_merging():
    result = subprocess.run("git status", capture_output=True, text=True, shell=True)
    return "Unmerged paths:" in result.stdout


all_files = glob.glob("*.tex")
for filename_tex in all_files:
    if (filename_tex == "main.tex") or ("temp" in filename_tex):
        continue

    filename_lyx = filename_tex.replace(".tex", ".lyx")

    try:
        run(f'lyx --export-to latex {filename_tex} -f {filename_lyx}')
        gawk_command = r"gawk '/\\begin\{document\}/,/\\end\{document\}/ {if (!/\\begin\{document\}/ && !/\\end\{document\}/ && !/^\\include/) print}' "
        run(gawk_command + f'{filename_tex} > temp_file.tex', )
        os.rename('temp_file.tex', filename_tex)

        run(f'git add {filename_tex}', )
        run(f'git commit -m "commit ours {filename_tex}" --no-verify')
        run('git stash -u', )
        run('git fetch', )
        run(f'touch {OVERLYX_DIR}/.disable_hooks')
        
        run('git merge --no-ff -X theirs --no-verify origin/master -m "Merge origin into local"', check=True)

        run(f'rm {OVERLYX_DIR}/.disable_hooks')

        # Detect if a merge conflict has occurred
        if is_git_merging():
            print_and_log("! Merge conflict detected. Please resolve the conflict and commit. Waiting for resolution...")
            while is_git_merging():
                time.sleep(1)  # Check every 1 seconds
            print_and_log("Merge conflict resolved. Continuing...")

        run('git stash pop', )
        run(f'tex2lyx -f {filename_tex}', )
        run('git reset --soft HEAD@{2}', )

    except subprocess.CalledProcessError:
        print_and_log("An error occurred. Please check the logs. Exiting.")
        break

print_and_log("Post-merge processing completed.")