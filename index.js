var crypto = require('crypto');
var path = require('path');
var ReplaceSource = require('webpack-core/lib/ReplaceSource');

function makePlaceholder(id) {
  return '*-*-*-CHUNK-SRI-HASH-' + id + '-*-*-*';
}

function findDepChunks(chunk, allDepChunkIds) {
  chunk.chunks.forEach(function forEachChunk(depChunk) {
    if (!allDepChunkIds[depChunk.id]) {
      allDepChunkIds[depChunk.id] = true;
    }
    findDepChunks(depChunk, allDepChunkIds);
  });
}

/*  Given a public URL path to an asset, as generated by
 *  HtmlWebpackPlugin for use as a `<script src>` or `<link href`> URL
 *  in `index.html`, return the path in the filesystem relative to the
 *  webpack output directory, suitable as a key into
 *  `compilation.assets`.
 */
function hwpSrcRelativeOutputPath(compiler, htmlWebpackPlugin, src) {
  var webpackOutputPath = compiler.options.output.path;

  // For publicPath we need to fall back to the empty string like
  // webpack does (see e.g. webpack/lib/MainTemplate.js)
  var webpackPublicPath = compiler.options.output.publicPath || '';

  // Strip cache-busting hash query possibly added by HtmlWebpackPlugin
  var srcWithoutHash = src.replace(/\?[a-zA-Z0-9]+$/, '');

  // Determine source path relative to webpack public path
  var srcPathRelativeToPublic = path.relative(webpackPublicPath, srcWithoutHash);

  // Using this source path, determine full output path name in
  // filesystem
  var hwpOutputPath = path.dirname(htmlWebpackPlugin.options.filename);
  var outputAssetPath = path.resolve(webpackOutputPath,
                                     hwpOutputPath,
                                     srcPathRelativeToPublic);

  // Return the output path name relative to webpack output directory
  return path.relative(webpackOutputPath, outputAssetPath);
}

function WebIntegrityJsonpMainTemplatePlugin() {}

WebIntegrityJsonpMainTemplatePlugin.prototype.apply = function apply(mainTemplate) {
  /*
   *  Patch jsonp-script code to add the integrity attribute.
   */
  mainTemplate.plugin('jsonp-script', function jsonpScriptPlugin(source) {
    return this.asString([
      source,
      'script.integrity = sriHashes[chunkId];'
    ]);
  });

  /*
   *  Patch local-vars code to add a mapping from chunk ID to SRIs.
   *  Since SRIs haven't been computed at this point, we're using
   *  magic placeholders for SRI values and going to replace them
   *  later.
   */
  mainTemplate.plugin('local-vars', function localVarsPlugin(source, chunk) {
    if (chunk.chunks.length > 0) {
      var allDepChunkIds = {};
      findDepChunks(chunk, allDepChunkIds);

      return this.asString([
        source,
        'var sriHashes = {',
        this.indent(
          Object.keys(allDepChunkIds).map(function mapChunkId(chunkId) {
            return chunkId + ':"' + makePlaceholder(chunkId) + '"';
          }).join(',\n')
        ),
        '};'
      ]);
    }
    return source;
  });
};

function SubresourceIntegrityPlugin(algorithms) {
  if (typeof algorithms === 'string') {
    this.algorithms = [ algorithms ];
  } else if (!Array.isArray(algorithms)) {
    throw new Error('Expected an array of strings or a string');
  } else if (algorithms.length === 0) {
    throw new Error('Algorithms array must not be empty');
  } else {
    this.algorithms = algorithms;
  }
}

SubresourceIntegrityPlugin.prototype.apply = function apply(compiler) {
  var algorithms = this.algorithms;

  function computeIntegrity(source) {
    return algorithms.map(function mapAlgo(algo) {
      var hash = crypto.createHash(algo).update(source, 'utf8').digest('base64');
      return algo + '-' + hash;
    }).join(' ');
  }

  compiler.plugin('after-plugins', function afterPlugins() {
    compiler.plugin('this-compilation', function thisCompilation(compilation) {
      compilation.mainTemplate.apply(new WebIntegrityJsonpMainTemplatePlugin());

      /*
       *  Calculate SRI values for each chunk and replace the magic
       *  placeholders by the actual values.
       */
      compilation.plugin('after-optimize-assets', function optimizeAssetsPlugin(assets) {
        var hashByChunkId = {};
        var visitedByChunkId = {};
        function processChunkRecursive(chunk) {
          var depChunkIds = [];

          if (visitedByChunkId[chunk.id]) {
            return [];
          }
          visitedByChunkId[chunk.id] = true;

          chunk.chunks.forEach(function mapChunk(depChunk) {
            depChunkIds = depChunkIds.concat(processChunkRecursive(depChunk));
          });

          if (chunk.files.length > 0) {
            var chunkFile = chunk.files[0];

            var oldSource = assets[chunkFile].source();

            var newAsset = new ReplaceSource(assets[chunkFile]);

            depChunkIds.forEach(function forEachChunk(depChunkId) {
              var magicMarker = makePlaceholder(depChunkId);
              var magicMarkerPos = oldSource.indexOf(magicMarker);
              if (magicMarkerPos >= 0) {
                newAsset.replace(
                  magicMarkerPos,
                  magicMarkerPos + magicMarker.length - 1,
                  hashByChunkId[depChunkId]);
              }
            });

            assets[chunkFile] = newAsset;

            var newSource = newAsset.source();
            hashByChunkId[chunk.id] = newAsset.integrity = computeIntegrity(newSource);
          }
          return [ chunk.id ].concat(depChunkIds);
        }

        compilation.chunks.forEach(function forEachChunk(chunk) {
          // chunk.entry was removed in Webpack 2. Use hasRuntime() for this check instead (if it exists)
          if (('hasRuntime' in chunk) ? chunk.hasRuntime() : chunk.entry) {
            processChunkRecursive(chunk);
          }
        });

        for (var key in assets) {
          if (assets.hasOwnProperty(key)) {
            var asset = assets[key];
            if (!asset.integrity) {
              asset.integrity = computeIntegrity(asset.source());
            }
          }
        }
      });

      function getTagSrc(tag) {
        // Get asset path - src from scripts and href from links
        return tag.attributes.href || tag.attributes.src;
      }

      function filterTag(tag) {
        // Process only script and link tags with a url
        return (tag.tagName === 'script' || tag.tagName === 'link') && getTagSrc(tag);
      }

      function getIntegrityChecksumForAsset(src) {
        var asset = compilation.assets[src];
        return asset && asset.integrity;
      }

      function alterAssetTags(pluginArgs, callback) {
        /* html-webpack-plugin has added an event so we can pre-process the html tags before they
           inject them. This does the work.
        */
        function processTag(tag) {
          var src = hwpSrcRelativeOutputPath(compiler, pluginArgs.plugin, getTagSrc(tag));
          var checksum = getIntegrityChecksumForAsset(src);
          if (!checksum) {
            compilation.warnings.push(new Error(
              "webpack-subresource-integrity: cannot determine hash for asset '" +
                src + "', the resource will be unprotected."));
            return;
          }
          // Add integrity check sums
          tag.attributes.integrity = checksum;
          tag.attributes.crossorigin = 'anonymous';
        }

        pluginArgs.head.filter(filterTag).forEach(processTag);
        pluginArgs.body.filter(filterTag).forEach(processTag);
        callback(null, pluginArgs);
      }

      /*  Add jsIntegrity and cssIntegrity properties to pluginArgs, to
       *  go along with js and css properties.  These are later
       *  accessible on `htmlWebpackPlugin.files`.
       */
      function beforeHtmlGeneration(pluginArgs, callback) {
        ['js', 'css'].forEach(function addIntegrity(fileType) {
          pluginArgs.assets[fileType + 'Integrity'] =
            pluginArgs.assets[fileType].map(function assetIntegrity(filePath) {
              var src = hwpSrcRelativeOutputPath(compilation.compiler,
                                                 pluginArgs.plugin,
                                                 filePath);
              return compilation.assets[src].integrity;
            });
        });
        callback(null, pluginArgs);
      }

      /*
       *  html-webpack support:
       *    Modify the asset tags before webpack injects them for anything with an integrity value.
       */
      compilation.plugin('html-webpack-plugin-alter-asset-tags', alterAssetTags);
      compilation.plugin('html-webpack-plugin-before-html-generation', beforeHtmlGeneration);
    });
  });
};

module.exports = SubresourceIntegrityPlugin;
