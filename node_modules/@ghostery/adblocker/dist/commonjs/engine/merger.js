"use strict";
/*!
 * Copyright (c) 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeMetadata = mergeMetadata;
exports.mergeLists = mergeLists;
exports.mergePreprocessors = mergePreprocessors;
exports.legacyMerge = legacyMerge;
exports.binaryMerge = binaryMerge;
const config_js_1 = __importDefault(require("../config.js"));
const preprocessor_js_1 = __importDefault(require("../preprocessor.js"));
const resources_js_1 = __importDefault(require("../resources.js"));
const cosmetic_js_1 = __importDefault(require("./bucket/cosmetic.js"));
const filters_js_1 = __importDefault(require("./bucket/filters.js"));
const html_js_1 = __importDefault(require("./bucket/html.js"));
const network_js_1 = __importDefault(require("./bucket/network.js"));
const preprocessor_js_2 = __importDefault(require("./bucket/preprocessor.js"));
const metadata_js_1 = require("./metadata.js");
const optimizer_js_1 = require("./optimizer.js");
const reverse_index_js_1 = __importDefault(require("./reverse-index.js"));
function mergeMetadata(engines) {
    const metadata = {
        organizations: {},
        categories: {},
        patterns: {},
    };
    for (const engine of engines) {
        if (engine.metadata !== undefined) {
            for (const organization of engine.metadata.organizations.getValues()) {
                if (metadata.organizations[organization.key] === undefined) {
                    metadata.organizations[organization.key] = organization;
                }
            }
            for (const category of engine.metadata.categories.getValues()) {
                if (metadata.categories[category.key] === undefined) {
                    metadata.categories[category.key] = category;
                }
            }
            for (const pattern of engine.metadata.patterns.getValues()) {
                if (metadata.patterns[pattern.key] === undefined) {
                    metadata.patterns[pattern.key] = pattern;
                }
            }
        }
    }
    return metadata;
}
function mergeLists(engines) {
    const lists = new Map();
    for (const engine of engines) {
        for (const [key, value] of engine.lists) {
            if (lists.has(key)) {
                continue;
            }
            lists.set(key, value);
        }
    }
    return lists;
}
function mergePreprocessors(engines) {
    const preprocessors = [];
    for (const engine of engines) {
        for (const preprocessor of engine.preprocessors.preprocessors) {
            const local = preprocessors.find((local) => local.condition === preprocessor.condition);
            if (local === undefined) {
                preprocessors.push(new preprocessor_js_1.default({
                    condition: preprocessor.condition,
                    filterIDs: new Set(preprocessor.filterIDs),
                }));
                continue;
            }
            for (const filterID of preprocessor.filterIDs) {
                local.filterIDs.add(filterID);
            }
        }
    }
    return preprocessors;
}
function hasMetadata(metadata) {
    return (Object.keys(metadata.categories).length +
        Object.keys(metadata.organizations).length +
        Object.keys(metadata.patterns).length !==
        0);
}
/**
 * Legacy semantic merge implementation, moved out of `FilterEngine.merge` so it
 * can live next to byte-level merging during the transition.
 */
function legacyMerge(self, engines, { skipResources = false, overrideConfig = {} } = {}) {
    if (!engines || engines.length < 2) {
        throw new Error('merging engines requires at least two engines');
    }
    for (const engine of engines) {
        if (engine.config.enableCompression !== engines[0].config.enableCompression) {
            throw new Error(`compression of all merged engines must match with the first one: "${engines[0].config.enableCompression}" but got: "${engine.config.enableCompression}"`);
        }
    }
    const networkFilters = new Map();
    const cosmeticFilters = new Map();
    const metadata = mergeMetadata(engines);
    const lists = mergeLists(engines);
    const preprocessors = mergePreprocessors(engines);
    for (const engine of engines) {
        const filters = engine.getFilters();
        for (const networkFilter of filters.networkFilters) {
            networkFilters.set(networkFilter.getId(), networkFilter);
        }
        for (const cosmeticFilter of filters.cosmeticFilters) {
            cosmeticFilters.set(cosmeticFilter.getId(), cosmeticFilter);
        }
    }
    const engine = new self({
        networkFilters: Array.from(networkFilters.values()),
        cosmeticFilters: Array.from(cosmeticFilters.values()),
        preprocessors,
        lists,
        config: new config_js_1.default({ ...engines[0].config, ...overrideConfig }),
    });
    if (hasMetadata(metadata)) {
        engine.metadata = new metadata_js_1.Metadata(metadata);
    }
    if (skipResources !== true) {
        for (const engine of engines.slice(1)) {
            if (engine.resources.checksum !== engines[0].resources.checksum) {
                throw new Error(`resource checksum of all merged engines must match with the first one: "${engines[0].resources.checksum}" but got: "${engine.resources.checksum}"`);
            }
        }
        engine.resources = resources_js_1.default.copy(engines[0].resources);
    }
    return engine;
}
function mergeNetworkFilterBucket(sources, config, hashFunc) {
    const bucket = new network_js_1.default({ config });
    const optimize = config.enableOptimizations ? optimizer_js_1.optimizeNetwork : optimizer_js_1.noopOptimizeNetwork;
    bucket.index = reverse_index_js_1.default.merge(sources.map((source) => source.index), config, optimize, { hashFunc });
    bucket.badFilters = filters_js_1.default.merge(sources.map((source) => source.badFilters), { hashFunc });
    return bucket;
}
function mergeCosmeticFilterBucket(sources, config, hashFunc) {
    const bucket = new cosmetic_js_1.default({ config });
    bucket.genericRules = filters_js_1.default.merge(sources.map((source) => source.genericRules), { hashFunc });
    bucket.classesIndex = reverse_index_js_1.default.merge(sources.map((source) => source.classesIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
    bucket.hostnameIndex = reverse_index_js_1.default.merge(sources.map((source) => source.hostnameIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
    bucket.hrefsIndex = reverse_index_js_1.default.merge(sources.map((source) => source.hrefsIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
    bucket.idsIndex = reverse_index_js_1.default.merge(sources.map((source) => source.idsIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
    bucket.unhideIndex = reverse_index_js_1.default.merge(sources.map((source) => source.unhideIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
    return bucket;
}
function mergeHTMLBucket(sources, config, hashFunc) {
    const bucket = new html_js_1.default({ config });
    const optimize = config.enableOptimizations ? optimizer_js_1.optimizeNetwork : optimizer_js_1.noopOptimizeNetwork;
    if (config.loadNetworkFilters === true) {
        bucket.networkIndex = reverse_index_js_1.default.merge(sources.map((source) => source.networkIndex), config, optimize, {
            hashFunc,
        });
        bucket.exceptionsIndex = reverse_index_js_1.default.merge(sources.map((source) => source.exceptionsIndex), config, optimize, { hashFunc });
    }
    if (config.loadCosmeticFilters === true) {
        bucket.cosmeticIndex = reverse_index_js_1.default.merge(sources.map((source) => source.cosmeticIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
        bucket.unhideIndex = reverse_index_js_1.default.merge(sources.map((source) => source.unhideIndex), config, optimizer_js_1.noopOptimizeCosmetic, { hashFunc });
    }
    return bucket;
}
function binaryMerge(self, engines, { skipResources = false, overrideConfig = {}, hashFunc } = {}) {
    if (!engines || engines.length < 2) {
        throw new Error('merging engines requires at least two engines');
    }
    for (const engine of engines) {
        if (engine.config.enableCompression !== engines[0].config.enableCompression) {
            throw new Error(`compression of all merged engines must match with the first one: "${engines[0].config.enableCompression}" but got: "${engine.config.enableCompression}"`);
        }
        if (engine.config.debug === true) {
            throw new Error('merging engines with binaryMerge method is not allowed with debug mode strictly!');
        }
    }
    if (overrideConfig.debug === true) {
        throw new Error(`the resulting engine cannot have debug or compression when merging engines with binaryMerge method!`);
    }
    if (typeof overrideConfig.enableCompression === 'boolean' &&
        overrideConfig.enableCompression !== engines[0].config.enableCompression) {
        throw new Error(`the resulting engine should have same compression config when merging engines!`);
    }
    const metadata = mergeMetadata(engines);
    const lists = mergeLists(engines);
    const config = new config_js_1.default({ ...engines[0].config, ...overrideConfig });
    const engine = new self({
        config,
        lists,
    });
    // Bucket skipping follows target config loading flags. Do not skip buckets
    // for loadExtendedSelectors, enableInMemoryCache, or enableOptimizations:
    // those tune matching/injection/cache/optimizer behavior, not whole bucket
    // loading.
    engine.preprocessors = new preprocessor_js_2.default({
        preprocessors: config.loadPreprocessors === true ? mergePreprocessors(engines) : [],
    });
    if (config.loadNetworkFilters === true) {
        engine.importants = mergeNetworkFilterBucket(engines.map((source) => source.importants), config, hashFunc);
        engine.redirects = mergeNetworkFilterBucket(engines.map((source) => source.redirects), config, hashFunc);
        engine.removeparams = mergeNetworkFilterBucket(engines.map((source) => source.removeparams), config, hashFunc);
        engine.filters = mergeNetworkFilterBucket(engines.map((source) => source.filters), config, hashFunc);
        engine.exceptions =
            config.loadExceptionFilters === true
                ? mergeNetworkFilterBucket(engines.map((source) => source.exceptions), config, hashFunc)
                : new network_js_1.default({ config });
        engine.csp =
            config.loadCSPFilters === true
                ? mergeNetworkFilterBucket(engines.map((source) => source.csp), config, hashFunc)
                : new network_js_1.default({ config });
        engine.hideExceptions = mergeNetworkFilterBucket(engines.map((source) => source.hideExceptions), config, hashFunc);
    }
    if (config.loadCosmeticFilters === true) {
        engine.cosmetics = mergeCosmeticFilterBucket(engines.map((source) => source.cosmetics), config, hashFunc);
    }
    if (config.enableHtmlFiltering === true) {
        engine.htmlFilters = mergeHTMLBucket(engines.map((source) => source.htmlFilters), config, hashFunc);
    }
    if (hasMetadata(metadata)) {
        engine.metadata = new metadata_js_1.Metadata(metadata);
    }
    if (skipResources !== true) {
        for (const engine of engines.slice(1)) {
            if (engine.resources.checksum !== engines[0].resources.checksum) {
                throw new Error(`resource checksum of all merged engines must match with the first one: "${engines[0].resources.checksum}" but got: "${engine.resources.checksum}"`);
            }
        }
        engine.resources = resources_js_1.default.copy(engines[0].resources);
    }
    return engine;
}
//# sourceMappingURL=merger.js.map