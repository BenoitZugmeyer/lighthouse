/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const makeComputedArtifact = require('../computed-artifact.js');
const LanternMetric = require('./lantern-metric.js');
const BaseNode = require('../../lib/dependency-graph/base-node.js');

/** @typedef {BaseNode.Node} Node */
/** @typedef {import('../../lib/dependency-graph/cpu-node')} CPUNode */
/** @typedef {import('../../lib/dependency-graph/network-node')} NetworkNode */

class LanternFirstContentfulPaint extends LanternMetric {
  /**
   * @return {LH.Gatherer.Simulation.MetricCoefficients}
   */
  static get COEFFICIENTS() {
    return {
      intercept: 0,
      optimistic: 0.5,
      pessimistic: 0.5,
    };
  }

  /**
   * This function computes the set of URLs that *appeared* to be render-blocking based on our filter,
   * *but definitely were not* render-blocking based on the timing of their EvaluateScript task.
   * It also computes the set of corresponding CPU node ids that were needed for the paint at the
   * given timestamp.
   *
   * @param {Node} graph
   * @param {number} filterTimestamp The timestamp used to filter out tasks that occured after our
   *    paint of interest. Typically this is First Contentful Paint or First Meaningful Paint.
   * @param {function(NetworkNode):boolean} blockingScriptFilter The function that determines which scripts
   *    should be considered *possibly* render-blocking.
   * @param {(function(CPUNode):boolean)=} extraBlockingCpuNodesToIncludeFilter The function that determines which CPU nodes
   *    should also be included in our blocking node IDs set.
   * @return {{definitelyNotRenderBlockingScriptUrls: Set<string>, blockingCpuNodeIds: Set<string>}}
   */
  static getBlockingCpuData(
      graph,
      filterTimestamp,
      blockingScriptFilter,
      extraBlockingCpuNodesToIncludeFilter
  ) {
    /** @type {Array<CPUNode>} */
    const cpuNodes = [];
    graph.traverse(node => {
      if (node.type === BaseNode.TYPES.CPU && node.startTime <= filterTimestamp) {
        cpuNodes.push(node);
      }
    });

    cpuNodes.sort((a, b) => a.startTime - b.startTime);

    // A script is *possibly* render blocking if it finished loading before FCP
    const possiblyRenderBlockingScriptUrls = LanternMetric.getScriptUrls(graph, node => {
      return node.endTime <= filterTimestamp && blockingScriptFilter(node);
    });

    // A script is *definitely not* render blocking if its EvaluateScript task finished after FCP.
    /** @type {Set<string>} */
    const definitelyNotRenderBlockingScriptUrls = new Set();
    /** @type {Set<string>} */
    const blockingCpuNodeIds = new Set();
    for (const url of possiblyRenderBlockingScriptUrls) {
      let hadEvaluateScript = false;

      for (const cpuNode of cpuNodes) {
        if (cpuNode.isEvaluateScriptFor(new Set([url]))) {
          hadEvaluateScript = true;
          blockingCpuNodeIds.add(cpuNode.id);
          break;
        }
      }

      // We couldn't find the evaluate script in the set of CPU nodes that ran before our paint, so
      // it must not have been necessary for the paint.
      if (!hadEvaluateScript) definitelyNotRenderBlockingScriptUrls.add(url);
    }

    // The first layout, first paint, and first ParseHTML are almost always necessary for first paint,
    // so we always include those CPU nodes.
    const firstLayout = cpuNodes.find(node => node.didPerformLayout());
    if (firstLayout) blockingCpuNodeIds.add(firstLayout.id);
    const firstPaint = cpuNodes.find(node => node.childEvents.some(e => e.name === 'Paint'));
    if (firstPaint) blockingCpuNodeIds.add(firstPaint.id);
    const firstParse = cpuNodes.find(node => node.childEvents.some(e => e.name === 'ParseHTML'));
    if (firstParse) blockingCpuNodeIds.add(firstParse.id);

    // If a CPU filter was passed in, we also want to include those extra nodes.
    if (extraBlockingCpuNodesToIncludeFilter) {
      cpuNodes
        .filter(extraBlockingCpuNodesToIncludeFilter)
        .forEach(node => blockingCpuNodeIds.add(node.id));
    }

    return {
      definitelyNotRenderBlockingScriptUrls,
      blockingCpuNodeIds,
    };
  }

  /**
   * This function computes the graph required for the first paint of interest.
   *
   * @param {Node} dependencyGraph
   * @param {number} paintTs
   * @param {function(NetworkNode):boolean} blockingScriptFilter
   * @param {function(CPUNode):boolean=} extraBlockingCpuNodesToIncludeFilter
   * @return {Node}
   */
  static getFirstPaintBasedGraph(
      dependencyGraph,
      paintTs,
      blockingScriptFilter,
      extraBlockingCpuNodesToIncludeFilter
  ) {
    const {
      definitelyNotRenderBlockingScriptUrls,
      blockingCpuNodeIds,
    } = this.getBlockingCpuData(
      dependencyGraph,
      paintTs,
      blockingScriptFilter,
      extraBlockingCpuNodesToIncludeFilter
    );

    return dependencyGraph.cloneWithRelationships(node => {
      if (node.type === BaseNode.TYPES.NETWORK) {
        // Exclude all nodes that ended after FCP (except for the main document which we always consider necessary)
        if (node.endTime > paintTs && !node.isMainDocument()) return false;

        const url = node.record.url;
        // If the URL definitely wasn't render-blocking then we filter it out.
        if (definitelyNotRenderBlockingScriptUrls.has(url)) {
          return false;
        }
        return node.hasRenderBlockingPriority();
      } else {
        // If it's a CPU node, just check if it was blocking.
        return blockingCpuNodeIds.has(node.id);
      }
    });
  }

  /**
   * @param {Node} dependencyGraph
   * @param {LH.Artifacts.TraceOfTab} traceOfTab
   * @return {Node}
   */
  static getOptimisticGraph(dependencyGraph, traceOfTab) {
    return this.getFirstPaintBasedGraph(
      dependencyGraph,
      traceOfTab.timestamps.firstContentfulPaint,
      node => node.hasRenderBlockingPriority() && node.initiatorType !== 'script'
    );
  }

  /**
   * @param {Node} dependencyGraph
   * @param {LH.Artifacts.TraceOfTab} traceOfTab
   * @return {Node}
   */
  static getPessimisticGraph(dependencyGraph, traceOfTab) {
    return this.getFirstPaintBasedGraph(
      dependencyGraph,
      traceOfTab.timestamps.firstContentfulPaint,
      node => node.hasRenderBlockingPriority()
    );
  }
}

module.exports = makeComputedArtifact(LanternFirstContentfulPaint);
