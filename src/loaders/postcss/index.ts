import path from "path";
import { ExistingRawSourceMap } from "rollup";
import { makeLegalIdentifier } from "@rollup/pluginutils";
import postcss from "postcss";
import findPostCSSConfig from "postcss-load-config";
import cssnano from "cssnano";

import { Loader, PostCSSLoaderOptions } from "../../types";
import { humanlizePath, normalizePath } from "../../utils/path-utils";
import { MapModifier } from "../../utils/sourcemap-utils";
import resolveAsync from "../../utils/resolve-async";
import safeId from "../../utils/safe-id";

import postcssModules from "./modules";
import postcssImportExport from "./import-export";
import postcssNoop from "./noop";

type LoadedConfig = {
  file?: string;
  options?: postcss.ProcessOptions;
  plugins?: (postcss.Transformer | postcss.Processor)[];
};

/**
 * @param id File path
 * @param config `postcss-load-config`'s options
 * @returns Loaded PostCSS config
 */
function loadConfig(id: string, config: PostCSSLoaderOptions["config"]): Promise<LoadedConfig> {
  const configPath =
    typeof config === "object" && config.path ? path.resolve(config.path) : path.dirname(id);

  const context: { [prop: string]: object | string } = {
    file: {
      extname: path.extname(id),
      dirname: path.dirname(id),
      basename: path.basename(id),
    },
    options: (typeof config === "object" && config.ctx) || {},
  };

  return findPostCSSConfig(context, configPath).catch(error => {
    if (!error.message.toLowerCase().includes("no postcss config found")) throw error;
    return {};
  });
}

/**
 * @param file Filename
 * @returns `true` if `file` matches `[name].module.[ext]` format, otherwise `false`
 */
function isModuleFile(file: string): boolean {
  return /\.module\.[a-z]+$/i.test(file);
}

const loader: Loader<PostCSSLoaderOptions> = {
  name: "postcss",
  alwaysProcess: true,
  async process({ code, map, extracted }) {
    const { options } = this;

    const config = await loadConfig(this.id, options.config);

    const plugins = [...(options.postcss.plugins || []), ...(config.plugins || [])];

    const autoModules = options.autoModules && isModuleFile(this.id);
    const supportModules = Boolean(options.modules || autoModules);

    const modulesExports: { [filepath: string]: { [prop: string]: string } } = {};

    const postcssOpts: PostCSSLoaderOptions["postcss"] & {
      from: string;
      to: string;
      map: postcss.ProcessOptions["map"];
    } = {
      ...options.postcss,
      ...config.options,
      from: this.id,
      // Set `to` to extract location, required for some plugins
      to: typeof options.extract === "string" ? path.resolve(options.extract) : this.id,
      // Annotation are still enabled if you have set {inline: true} in PostCSS `map` option
      map: Boolean(this.sourceMap) && { inline: false, annotation: false, sourcesContent: true },
    };

    delete postcssOpts.plugins;

    if (typeof postcssOpts.map === "object" && map)
      postcssOpts.map.prev = new MapModifier(map)
        .relative(path.dirname(postcssOpts.from))
        .toObject();

    if (supportModules) {
      const modulesOptions = typeof options.modules === "object" ? options.modules : {};
      plugins.push(
        ...postcssModules({
          // Skip hash while testing since CSS content would differ on Windows and Linux
          // due to different line endings.
          generateScopedName: process.env.NODE_ENV === "test" ? "[name]_[local]" : undefined,
          failOnWrongOrder: true,
          ...modulesOptions,
        }),
        postcssImportExport({
          extensions: options.extensions,
          getJSON(file, json, out) {
            modulesExports[file] = json;
            if (
              typeof options.modules === "object" &&
              typeof options.modules.getJSON === "function"
            ) {
              return options.modules.getJSON(file, json, out);
            }
          },
        }),
      );
    }

    // If extracting, minimization is performed afterwards
    if (!options.extract && options.minimize)
      plugins.push(cssnano(typeof options.minimize === "object" ? options.minimize : {}));

    // Prevent from PostCSS warning about no plugins
    if (plugins.length === 0) plugins.push(postcssNoop);

    const res = await postcss(plugins).process(code, postcssOpts);

    const deps = res.messages.filter(msg => msg.type === "dependency");
    for (const dep of deps) this.dependencies.add(dep.file);

    for (const warning of res.warnings())
      this.warn(warning.text, { column: warning.column, line: warning.line });

    if (res.map) {
      map =
        new MapModifier((res.map.toJSON() as unknown) as ExistingRawSourceMap)
          .resolve(path.dirname(postcssOpts.to))
          .toString() || map;
    }

    if (!options.extract && this.sourceMap && map)
      res.css += new MapModifier(map)
        .modify(map => void delete map.file)
        .relative()
        .toCommentData();

    let output = "\n";
    if (options.namedExports) {
      const json = modulesExports[this.id];

      const getClassName =
        typeof options.namedExports === "function" ? options.namedExports : makeLegalIdentifier;

      for (const name in json) {
        const newName = getClassName(name);

        // Skip logging when namedExports is a function since user can do that manually
        if (name !== newName && typeof options.namedExports !== "function")
          this.warn(`Exported "${name}" as "${newName}" in ${humanlizePath(this.id)}`);

        if (!json[newName]) json[newName] = json[name];

        output += `export const ${newName} = ${JSON.stringify(json[name])};\n`;
      }
    }

    const cssVarName = safeId("css");
    if (options.extract) {
      output += `export default ${JSON.stringify(modulesExports[this.id])};\n`;
      extracted = { id: this.id, code: res.css, map };
    } else {
      const defaultExport = supportModules ? JSON.stringify(modulesExports[this.id]) : cssVarName;
      output += `${[
        `var ${cssVarName} = ${JSON.stringify(res.css)};`,
        `export const stylesheet = ${cssVarName};`,
        `export default ${defaultExport};`,
      ].join("\n")}\n`;
    }

    if (!options.extract && options.inject) {
      if (typeof options.inject === "function") {
        output += options.inject(cssVarName, this.id);
      } else {
        const injectorName = safeId("injector");
        const injectorPath = normalizePath(
          await resolveAsync("./inject-css", {
            basedir: path.join(
              process.env.NODE_ENV === "test" ? process.cwd() : __dirname,
              "runtime",
            ),
          }),
        );
        const injectorData =
          typeof options.inject === "object" ? `,${JSON.stringify(options.inject)}` : "";
        output += `${[
          `import ${injectorName} from '${injectorPath}';`,
          `${injectorName}(${cssVarName}${injectorData});`,
        ].join("\n")}\n`;
      }
    }

    return { code: output, map, extracted };
  },
};

export default loader;
