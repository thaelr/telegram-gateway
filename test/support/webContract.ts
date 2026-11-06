import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Ajv2020} from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
const api=JSON.parse(fs.readFileSync(new URL('../../docs/openapi.web.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({strict:false,allErrors:true,validateFormats:false});
(addFormatsModule as unknown as (a:Ajv2020)=>void)(ajv);
ajv.addSchema({$id:'contract',components:api.components});
const validators=new Map<string,ReturnType<Ajv2020['compile']>>();
export function assertWebContract(name:string,data:unknown){
 let validate=validators.get(name);if(!validate){validate=ajv.compile({$ref:'contract#/components/schemas/'+name});validators.set(name,validate);}
 assert.ok(validate(JSON.parse(JSON.stringify(data))),name+': '+JSON.stringify(validate.errors));
}
