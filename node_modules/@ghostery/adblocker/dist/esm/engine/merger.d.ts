/*!
 * Copyright (c) 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import Config from '../config.js';
import Preprocessor from '../preprocessor.js';
import FilterEngine from './engine.js';
import { ICategory } from './metadata/categories.js';
import { IOrganization } from './metadata/organizations.js';
import { IPattern } from './metadata/patterns.js';
export type HashFunc = (arr: Uint8Array, beg: number, end: number) => number | string | bigint;
export type MergeOptions = {
    skipResources?: boolean;
    overrideConfig?: Partial<Config>;
    useBinaryMerge?: boolean;
    hashFunc?: HashFunc;
};
type MetadataCollection = {
    organizations: Record<string, IOrganization>;
    categories: Record<string, ICategory>;
    patterns: Record<string, IPattern>;
};
export declare function mergeMetadata<T extends typeof FilterEngine>(engines: InstanceType<T>[]): MetadataCollection;
export declare function mergeLists<T extends typeof FilterEngine>(engines: InstanceType<T>[]): Map<string, string>;
export declare function mergePreprocessors<T extends typeof FilterEngine>(engines: InstanceType<T>[]): Preprocessor[];
/**
 * Legacy semantic merge implementation, moved out of `FilterEngine.merge` so it
 * can live next to byte-level merging during the transition.
 */
export declare function legacyMerge<T extends typeof FilterEngine>(self: T, engines: InstanceType<T>[], { skipResources, overrideConfig }?: MergeOptions): InstanceType<T>;
export declare function binaryMerge<T extends typeof FilterEngine>(self: T, engines: InstanceType<T>[], { skipResources, overrideConfig, hashFunc }?: MergeOptions): InstanceType<T>;
export {};
//# sourceMappingURL=merger.d.ts.map