/** The document in its CRDT (model 2): see model.ts. */
export * from './model.ts';
export { Reader } from './read.ts';
export { Writer, writeDocument } from './write.ts';
export { diffKeys, type Run } from './diff.ts';
export { Binding, remoteTransaction, REMOTE_META, type RemoteMeta, type BindingOptions, type RemoteChange } from './binding.ts';
export { yPlace, relativePosition, documentPosition, placeToPos, type YPlace } from './positions.ts';
