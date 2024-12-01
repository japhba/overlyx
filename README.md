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
## TODO
- decide whether we should on pull export to tex, then merge, then reimport to lyx.


# Logic

- running the overlyx command in the tex directory will install a watcher for all lyx files in the tex directory, and export to tex on change while removing the lyx headers on non-main files. It should be run in a dedicated terminal and kept alrive by some mechanism. 
- Pull: Do as usual, but afterwards reimport all lyx files from the (user-)merged tex.
- Push: Nothing special to do, changes in LyX by virtue of the watcher will be already noticable.
