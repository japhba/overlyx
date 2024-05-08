To install the hooks into your repository, cd to its root directory (not this repository's) and run
```bash
git config core.hooksPath ~/overlyx/hooks
```
possibly replacing by the directory you cloned this repository to. 

To view, 
```
git config core.hooksPath
```
To unset,
```
git config --unset core.hooksPath
```
