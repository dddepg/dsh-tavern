import { JSDOM } from 'jsdom'
import { conversionInputError } from './mvu-conversion-guidance.js'
const escape = key => key.replace(/~/g,'~0').replace(/\//g,'~1')
export function componentFields(state,path='') {
  if (state && typeof state==='object' && !Array.isArray(state) && Object.keys(state).some(key=>!key.startsWith('$')&&!key.startsWith('__'))) {
    return Object.entries(state).filter(([key])=>!key.startsWith('$')&&!key.startsWith('__')).flatMap(([key,value])=>componentFields(value,path+'/'+escape(key)))
  }
  return path ? [{path,display:Array.isArray(state)?'list':'text'}] : []
}
// Model-owned layout may use named components; the tool owns numeric captures
// and list rendering. No dynamic attributes or arbitrary scripts are introduced.
export function compileMvuComponents(plan, states, {extendBindings=false} = {}) {
  if (!plan || !(plan.fields || typeof plan.html==='string'&&/<mvu-field\b/i.test(plan.html))) return plan
  if (Object.keys(plan).some(key=>!['fields','html','bindings','collectionPath'].includes(key)) || plan.bindings?.length&&!extendBindings || plan.collectionPath || plan.fields&&plan.html) throw conversionInputError('MVU_COMPONENT_INPUT_CONFLICT','字段组件不能与手工 bindings、collectionPath 或两套布局混用',{hint:'组件路径使用完整根路径；选择 fields 自动面板或含 mvu-field 的 html。'})
  const known=[...new Map(states.flatMap(state=>componentFields(state)).map(field=>[field.path,field])).values()]
  const dom=new JSDOM(plan.html || '<section class="mvu-fields"></section>')
  try {
    const doc=dom.window.document
    if (plan.fields) {
      if(!Array.isArray(plan.fields))throw Error('fields 必须是数组')
      const fields=plan.fields.concat(known.filter(field=>!plan.fields.some(selected=>selected.path===field.path||field.path.startsWith(selected.path+'/'))))
      for(const field of fields){
        const node=doc.createElement('mvu-field')
        node.setAttribute('path',field.path);node.setAttribute('display',field.display||'text');node.setAttribute('label',field.label ?? field.path.split('/').at(-1).replace(/~1/g,'/').replace(/~0/g,'~'))
        doc.querySelector('section').append(node)
      }
    }
    const bindings=extendBindings?structuredClone(plan.bindings||[]):[]
    let nextCapture=Math.max(0,...bindings.map(binding=>binding.capture))+1
    for(const node of [...doc.querySelectorAll('mvu-field')]){
      const path=node.getAttribute('path'),display=node.getAttribute('display')||'text'
      if([...node.attributes].some(attr=>!['path','display','label'].includes(attr.name))||node.childNodes.length||!['text','list'].includes(display)||!path)throw Error('mvu-field 只接受 path、label、display=text/list，不能包含子内容')
      if(nextCapture>99)throw Error('组件超过 99 个，请用对象或集合文本展示减少组件数')
      // Path validity and coverage are checked again by the saved definition.
      const keys=path.startsWith('/')?path.slice(1).split('/').map(key=>key.replace(/~1/g,'/').replace(/~0/g,'~')):[]
      if(!keys.length||keys.some(key=>['__proto__','prototype','constructor'].includes(key)))throw Error('组件需要有效的根 JSON Pointer')
      for(const state of states){let value=state;for(const key of keys){if(value==null||!Object.hasOwn(value,key))throw Error('组件字段不存在: '+path);value=value[key]}if(display==='list'&&!Array.isArray(value))throw Error('list 组件要求数组字段: '+path)}
      const capture=nextCapture++;bindings.push({capture,path,...(display==='list'?{display}:{})})
      const value=doc.createElement(display==='list'?'ul':'span')
      if(display==='list'){const item=doc.createElement('li');item.textContent='$'+capture;value.append(item)}else value.textContent='$'+capture
      const caption=node.getAttribute('label')
      if (caption) {
        const row=doc.createElement('div'),label=doc.createElement('strong')
        label.textContent=caption;row.append(label,value);node.replaceWith(row)
      } else node.replaceWith(value)
    }
    return {html:doc.documentElement.outerHTML,bindings}
  } finally {dom.window.close()}
}
