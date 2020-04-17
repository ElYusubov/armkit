import { CodeMaker } from 'codemaker';
import { JSONSchema4 } from 'json-schema';
import { TypeGenerator } from './type-generator';
import { ImportBase } from './base';
import { httpsGet } from './util';
import { writeFileSync } from 'fs-extra'
import * as path from 'path'
import * as $RefParser from "@apidevtools/json-schema-ref-parser";

export interface ImportArmTemplatesOptions {
  /**
   * The API version to generate.
   */
  readonly apiVersion: string;

  /**
   * FQNs of API object types to select instead of selecting the latest stable
   * version.
   * 
   * @default - selects the latest stable version from each API object
   */
  readonly include?: string[];

  /**
   * Do not import these types. Instead, represent them as "any".
   * 
   * @default - include all types that derive from the root types.
   */
  readonly exclude?: string[];
}

export class ImportKubernetesApi extends ImportBase {
  constructor(private readonly options: ImportArmTemplatesOptions) {
    super()
  }

  public get moduleNames() {
    return ['armkit'];
  }

  protected async generateTypeScript(code: CodeMaker) {
    const initialSchema = await downloadSchema(this.options.apiVersion);
    const resolvedSchema = await $RefParser.resolve(initialSchema)
    
    code.line(`// generated by armkit`);
    code.line(`import * as armkit from '@armkit/core';`);
    code.line(`import { Construct } from 'constructs';`);
    code.line();

    
    for (const path of resolvedSchema.paths()) {
      const schema = resolvedSchema.get(path)
      resolvedSchema.set(path, expandRefs(path, schema))
    }

    writeFileSync(path.join(process.cwd(), 'resolved.json'), JSON.stringify(resolvedSchema.values(), null, 2))

    const typeGenerator = new TypeGenerator(resolvedSchema);

    for (const path of resolvedSchema.paths()) {
      const schema = resolvedSchema.get(path)
      
      const topLevelObjects = findApiObjectDefinitions(schema as JSONSchema4)

      for (const o of topLevelObjects) {
        this.emitConstructForApiObject(typeGenerator, o);
      }
    }
        
    typeGenerator.generate(code);
  }

  private emitConstructForApiObject(typeGenerator: TypeGenerator, apidef: DeploymentObjectDefinition) {    
    typeGenerator.emitConstruct({
      fqn: `${apidef.namespace}.${apidef.name}`,
      kind: apidef.name,
      schema: apidef.schema,
    });
  }
}

function expandRefs(path: string, schema: any): any {
  const obj: {[key: string]: any} = {}
  
  for (const key of Object.keys(schema)) {
    const value = schema[key]
    let newValue: any

    if (typeof(value) === 'object') {
      if (Array.isArray(value)) {
        newValue = value.map((e) => ((typeof(e) === 'object') ? expandRefs(path, e) : e))
      } else {
        newValue = expandRefs(path, value)
      }
    } else {
      if (key === "$ref" && value.startsWith('#/definitions/')) {           
        newValue = `${path}${value}`
      } else {
        newValue = value
      }  
    }
    obj[key] = newValue
  }

  return obj
}

export function findApiObjectDefinitions(schema: JSONSchema4): DeploymentObjectDefinition[] {
  const list: DeploymentObjectDefinition[] = [];

  for (const [ typename, def ] of Object.entries(schema.definitions || { })) {  
    list.push({
      namespace: schema.title || 'undefined',
      name: typename,
      schema: def
    });
  }

  return list
}

interface DeploymentObjectName {
  namespace: string;
  name: string;
}

interface DeploymentObjectDefinition extends DeploymentObjectName {
  schema: JSONSchema4;
}

async function downloadSchema(schemaVersion: string) {
  const SCHEMA_URL = process.env.SCHEMA_DEFINITION_URL || `https://schema.management.azure.com/schemas/${schemaVersion}/deploymentTemplate.json`;
  const output = await httpsGet(SCHEMA_URL)
  return JSON.parse(output.toString()) as JSONSchema4;
}
