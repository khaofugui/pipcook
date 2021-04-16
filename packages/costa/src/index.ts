import {
  Runtime,
  DataSourceEntry,
  ModelEntry,
  DataFlowEntry,
  ScriptContext,
  FrameworkModule
} from '@pipcook/core';
import {
  PipcookScript,
  PipcookFramework,
  ScriptType
} from './types';
import * as BOA from '@pipcook/boa';
import * as Datacook from '@pipcook/datacook';
import * as path from 'path';
import Debug from 'debug';
import { importFrom } from './utils';

const debug = Debug('costa.runnable');

declare global {
  var boa: typeof BOA;
  var datacook: typeof Datacook;
}

// set boa and datacook to global for script
global.boa = BOA;
global.datacook = Datacook;

export * from './types';

export type DefaultRuntime = Runtime<Datacook.Dataset.Types.Sample<any>, Datacook.Dataset.Types.DatasetMeta>;

export type DefaultDataSource = Datacook.Dataset.Types.Dataset<Datacook.Dataset.Types.Sample<any>, Datacook.Dataset.Types.DatasetMeta>;

export type DefaultDataflowEntry = DataFlowEntry<Datacook.Dataset.Types.Sample<any>, Datacook.Dataset.Types.DatasetMeta>;

export type DefaultDataSourceEntry = DataSourceEntry<Datacook.Dataset.Types.Sample<any>, Datacook.Dataset.Types.DatasetMeta>;

export type DefaultModelEntry = ModelEntry<Datacook.Dataset.Types.Sample<any>, Datacook.Dataset.Types.DatasetMeta>;

export interface PipelineWorkSpace {
  /**
   * the current data directory for this runnable
   */
  dataDir: string;
  /**
   * the temporary directory for model
   */
  modelDir: string;
  /**
   * the cache directory
   */
  cacheDir: string;

  /**
   * framework directory
   */
  frameworkDir: string;
}

/**
 * `Costa` constructor options. For `Costa` creation,
 * the runtime should pass the framework information and
 * the specific workspace directory paths.
 */
export interface CostaOption {
  workspace: PipelineWorkSpace;
  framework: PipcookFramework;
}

/**
 * The pipeline runner who executes the scripts in the pipeline.
 */
export class Costa {
  /**
   * The context of the pipeline script.
   */
  public context: ScriptContext;

  /**
   * The consturctor of `Costa`.
   */
  constructor(
    /**
     * The options for the `Costa`, includes the framework info and the workspace directory paths.
     */
    public options: CostaOption
  ) {}

  /**
   * initialize framework, set python package path, node modules path and construct script context
   */
  async initFramework(): Promise<void> {
    global.boa.setenv(path.join(this.options.workspace.frameworkDir, this.options.framework.pythonPackagePath || 'site-packages'));
    const nodeModules = path.join(this.options.workspace.frameworkDir, this.options.framework.jsPackagePath || 'node_modules');
    const paths = [ nodeModules, ...(require.resolve.paths(__dirname) || []) ];
    this.context = {
      importJS: (jsModuleName: string): Promise<FrameworkModule> => {
        const module = require.resolve(jsModuleName, { paths });
        return import(module);
      },
      importPY: async (pythonPackageName: string): Promise<FrameworkModule> => {
        return boa.import(pythonPackageName);
      },
      workspace: {
        ...this.options.workspace
      }
    };
  }

  /**
   * import script and make sure the module export is a function
   * @param script script infomation
   * @param moduleExport module export
   */
  async importScript<T>(script: PipcookScript, type: ScriptType): Promise<T> {
    const scriptMoudle = await importFrom(script.path);
    let fn: T = scriptMoudle;
    if (typeof fn !== 'function' && type === ScriptType.DataSource) {
      const { datasource } = fn as any;
      if (typeof datasource === 'function') {
        fn = datasource;
      }
    }
    if (typeof fn !== 'function' && type === ScriptType.Dataflow) {
      const { dataflow } = fn as any;
      if (typeof dataflow === 'function') {
        fn = dataflow;
      }
    }
    if (typeof fn !== 'function' && type === ScriptType.Model) {
      const { model } = fn as any;
      if (typeof model === 'function') {
        fn = model;
      }
    }
    fn = typeof fn === 'function' ? fn : scriptMoudle.default;
    if (typeof fn !== 'function') {
      throw new TypeError(`no entry found in ${script.name}(${script.path})`);
    }
    return fn;
  }

  /**
   * Run a datasource script.
   * @param script The metadata of script.
   * @param options Options of the pipeline.
   * @returns The dataSource API object
   */
  async runDataSource(script: PipcookScript): Promise<DefaultDataSource> {
    // log all the requirements are ready to tell the debugger it's going to run.
    debug(`start loading the script(${script.name})`);
    const fn = await this.importScript<DefaultDataSourceEntry>(script, ScriptType.DataSource);
    debug(`loaded the script(${script.name}), start it.`);
    return await fn(script.query, this.context);
  }

  /**
   * Run a datasource script.
   * @param api api from data source script or another dataflow script
   * @param script the metadata of script
   */
  async runDataflow(api: DefaultDataSource, scripts: Array<PipcookScript>): Promise<DefaultDataSource> {
    for (const script of scripts) {
      debug(`start loading the script(${script.name})`);
      const fn = await this.importScript<DefaultDataflowEntry>(script, ScriptType.Dataflow);
      debug(`loaded the script(${script.name}), start it.`);
      api = await fn(api, script.query, this.context);
    }
    return api;
  }

  /**
   * Run a datasource script.
   * @param api api from data source script or dataflow script
   * @param script the metadata of script
   * @param options options of the pipeline
   */
  async runModel(api: DefaultRuntime, script: PipcookScript, options: Record<string, any>): Promise<void> {
    // log all the requirements are ready to tell the debugger it's going to run.
    debug(`start loading the script(${script.name})`);
    const fn = await this.importScript<DefaultModelEntry>(script, ScriptType.Model);
    // when the `load` is complete, start the plugin.
    debug(`loaded the script(${script.name}), start it.`);
    const opts = {
      ...options.train,
      ...script.query
    };
    return await fn(api, opts, this.context);
  }
}
