import { useState, useEffect, useRef } from "react";
import { useStore } from "../../store";
import { useTr } from "../../i18n/text";
import { ModalWindowControls } from "./ModalWindowControls";

type RestrictedBackgroundStyle = "waves" | "warp" | "warpLegacy" | "bubbles";

function normalizeRestrictedBackgroundStyle(value: string | undefined): RestrictedBackgroundStyle {
  if (value === "bubbles" || value === "warp" || value === "warpLegacy" || value === "waves") {
    return value;
  }
  return "warp";
}

function parseCssColor(raw: string): [number, number, number] {
  const s = raw.trim();
  if (!s) return [0, 0, 0];
  const el = document.createElement("canvas");
  el.width = el.height = 1;
  const ctx = el.getContext("2d");
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}

function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    appBg: parseCssColor(cs.getPropertyValue("--app-bg")),
    accent: parseCssColor(cs.getPropertyValue("--accent-color")),
    accentSoft: parseCssColor(cs.getPropertyValue("--accent-soft")),
    panelSoft: parseCssColor(cs.getPropertyValue("--panel-soft")),
  };
}

const VERT_SRC = `attribute vec2 a_pos;void main(){gl_Position=vec4(a_pos,0,1);}`;

const WARP_FRAG = `precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform vec3 u_c0,u_c1,u_c2,u_c3;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1,0):vec2(0,1);
  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0,i1.y,1))+i.x+vec3(0,i1.x,1));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m;m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0;vec3 h=abs(x)-0.5;
  vec3 ox=floor(x+0.5);vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}
void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  float t=u_time*0.16;
  float aspect=u_res.x/u_res.y;
  vec2 p=(uv-0.5)*vec2(aspect*4.9,4.9);
  vec2 flowA=vec2(
    snoise(p*0.32+vec2(t*0.24,-t*0.18)),
    snoise(p*0.29+vec2(-t*0.16,t*0.22)+vec2(7.1,2.4))
  );
  vec2 flowB=vec2(
    sin(t*0.37+p.y*0.86+flowA.y*1.8),
    cos(t*0.41-p.x*0.78+flowA.x*1.5)
  );
  vec2 warp=flowA*0.72+flowB*0.34;
  vec2 p1=p+warp*0.95;
  vec2 p2=p-warp.yx*0.82+vec2(cos(t*0.52),sin(t*0.45))*0.44;
  vec2 p3=p+vec2(warp.y,-warp.x)*0.66;
  float n1=snoise(p1*0.42+vec2(t*0.14,-t*0.11))*0.5+0.5;
  float n2=snoise(p2*0.54+vec2(4.7,2.3)+vec2(-t*0.09,t*0.16))*0.5+0.5;
  float n3=snoise(p3*0.31+vec2(n1,n2)*0.58+vec2(t*0.08,-t*0.1))*0.5+0.5;
  float n4=snoise((p-warp*0.78)*0.64+vec2(1.2,3.8)+vec2(-t*0.15,t*0.12))*0.5+0.5;
  float n5=snoise((p+flowA*1.2)*0.76+vec2(-2.1,1.7)+vec2(t*0.11,-t*0.17))*0.5+0.5;
  vec2 b1=vec2(-1.4+sin(t*0.62+flowB.x*0.6)*1.25,0.6+cos(t*0.54+flowA.y*0.4)*1.12);
  vec2 b2=vec2(1.5+cos(t*0.58+n2*1.8)*1.08,-0.8+sin(t*0.73+n1*1.3)*0.96);
  vec2 b3=vec2(0.3+sin(t*0.49+n3*2.1)*1.28,1.45+cos(t*0.78+n4*1.6)*0.92);
  vec2 b4=vec2(-1.1+cos(t*0.67+n4*1.4)*1.04,-1.3+sin(t*0.47+n2*1.7)*1.06);
  vec2 b5=vec2(1.75+sin(t*0.44+n1*1.8)*0.88,0.9+cos(t*0.69+n5*1.6)*1.16);
  vec2 b6=vec2(-0.45+cos(t*0.81+n3*1.5)*1.36,sin(t*0.61+n4*1.9)*1.24);
  vec2 b7=vec2(0.85+sin(t*0.53+n5*1.4-1.5)*1.06,-1.75+cos(t*0.43+n2*1.9)*0.82);
  vec2 b8=vec2(-1.95+sin(t*0.36+n1*2.0+2.0)*0.82,1.05+cos(t*0.87+n3*1.7)*1.02);
  vec2 b9=vec2(cos(t*0.74+n4*1.5)*1.46,-0.25+sin(t*0.57+n5*1.4)*1.36);
  vec2 b10=vec2(1.98+sin(t*0.48+n3*1.6-0.5)*0.74,-0.55+cos(t*0.82+n2*1.8)*1.08);
  float g1=exp(-0.18*dot(p-b1,p-b1));
  float g2=exp(-0.22*dot(p-b2,p-b2));
  float g3=exp(-0.16*dot(p-b3,p-b3));
  float g4=exp(-0.24*dot(p-b4,p-b4));
  float g5=exp(-0.19*dot(p-b5,p-b5));
  float g6=exp(-0.2*dot(p-b6,p-b6));
  float g7=exp(-0.25*dot(p-b7,p-b7));
  float g8=exp(-0.17*dot(p-b8,p-b8));
  float g9=exp(-0.15*dot(p-b9,p-b9));
  float g10=exp(-0.21*dot(p-b10,p-b10));
  vec3 c=u_c0;
  c=mix(c,u_c1,g1*n1*0.62);
  c=mix(c,u_c2,g2*n2*0.56);
  c=mix(c,u_c3,g3*n3*0.52);
  c=mix(c,mix(u_c1,u_c3,0.5),g4*n2*0.46);
  c=mix(c,mix(u_c2,u_c1,0.4),g5*n1*0.42);
  c=mix(c,u_c1,g6*n4*0.51);
  c=mix(c,u_c3,g7*n1*0.47);
  c=mix(c,mix(u_c2,u_c3,0.6),g8*n3*0.52);
  c=mix(c,mix(u_c1,u_c2,0.5),g9*n4*0.56);
  c=mix(c,mix(u_c3,u_c1,0.3),g10*n2*0.42);
  c=mix(c,mix(u_c1,u_c2,n3),smoothstep(0.42,0.82,n3)*0.24);
  c=mix(c,mix(u_c2,u_c3,n5),smoothstep(0.48,0.86,n5)*0.2);
  float filament=smoothstep(0.58,0.84,n5)*smoothstep(0.18,0.52,n2);
  c+=mix(u_c1,u_c2,n4)*filament*0.1;
  float edge=smoothstep(0.38,0.54,n3)*smoothstep(0.66,0.5,n3);
  c+=vec3(1.0,0.98,0.95)*edge*0.09;
  float shimmer=pow(max(sin((n1*1.6+n4*1.2+t*0.7)*3.14159265),0.0),2.8);
  c+=vec3(1.0,0.99,0.96)*shimmer*0.045;
  vec2 vig=uv*(1.0-uv);
  c*=pow(vig.x*vig.y*16.0,0.1);
  gl_FragColor=vec4(c,1.0);
}`;

const WARP_FRAG_LEGACY = `precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform vec3 u_c0,u_c1,u_c2,u_c3;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1,0):vec2(0,1);
  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0,i1.y,1))+i.x+vec3(0,i1.x,1));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
  m=m*m;m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0;vec3 h=abs(x)-0.5;
  vec3 ox=floor(x+0.5);vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}
void main(){
  vec2 uv=gl_FragCoord.xy/u_res;
  float t=u_time*0.13;
  float aspect=u_res.x/u_res.y;
  vec2 p=(uv-0.5)*vec2(aspect*5.0,5.0);
  float n1=snoise(p*0.4+t*0.3)*0.5+0.5;
  float n2=snoise(p*0.5+vec2(4.7,2.3)+t*0.25)*0.5+0.5;
  float n3=snoise(p*0.3+vec2(n1,n2)*0.4+t*0.2)*0.5+0.5;
  float n4=snoise(p*0.6+vec2(1.2,3.8)-t*0.15)*0.5+0.5;
  vec2 b1=vec2(-1.5+sin(t*0.7+sin(t*0.3))*1.2,0.5+cos(t*0.55+cos(t*0.4))*1.1);
  vec2 b2=vec2(1.4+cos(t*0.6)*1.1,-0.7+sin(t*0.75+sin(t*0.5)*0.3)*1.0);
  vec2 b3=vec2(0.2+sin(t*0.5+1.0)*1.3,1.5+cos(t*0.8)*0.9);
  vec2 b4=vec2(-1.2+cos(t*0.65+sin(t*0.35)*0.5)*1.0,-1.4+sin(t*0.5)*1.1);
  vec2 b5=vec2(1.7+sin(t*0.45)*0.9,0.8+cos(t*0.7+cos(t*0.25))*1.2);
  vec2 b6=vec2(-0.5+cos(t*0.8+sin(t*0.6)*0.4)*1.4,sin(t*0.65)*1.3);
  vec2 b7=vec2(0.8+sin(t*0.55-1.5)*1.1,-1.8+cos(t*0.4+sin(t*0.7)*0.3)*0.8);
  vec2 b8=vec2(-2.0+sin(t*0.35+2.0)*0.8,1.0+cos(t*0.9)*1.0);
  vec2 b9=vec2(cos(t*0.75+sin(t*0.5))*1.5,-0.3+sin(t*0.6+cos(t*0.3)*0.5)*1.4);
  vec2 b10=vec2(2.0+sin(t*0.5-0.5)*0.7,-0.5+cos(t*0.85+sin(t*0.45))*1.1);
  float g1=exp(-0.18*dot(p-b1,p-b1));
  float g2=exp(-0.22*dot(p-b2,p-b2));
  float g3=exp(-0.16*dot(p-b3,p-b3));
  float g4=exp(-0.24*dot(p-b4,p-b4));
  float g5=exp(-0.19*dot(p-b5,p-b5));
  float g6=exp(-0.2*dot(p-b6,p-b6));
  float g7=exp(-0.25*dot(p-b7,p-b7));
  float g8=exp(-0.17*dot(p-b8,p-b8));
  float g9=exp(-0.15*dot(p-b9,p-b9));
  float g10=exp(-0.21*dot(p-b10,p-b10));
  vec3 c=u_c0;
  c=mix(c,u_c1,g1*n1*0.6);
  c=mix(c,u_c2,g2*n2*0.55);
  c=mix(c,u_c3,g3*n3*0.5);
  c=mix(c,mix(u_c1,u_c3,0.5),g4*n2*0.45);
  c=mix(c,mix(u_c2,u_c1,0.4),g5*n1*0.4);
  c=mix(c,u_c1,g6*n4*0.5);
  c=mix(c,u_c3,g7*n1*0.45);
  c=mix(c,mix(u_c2,u_c3,0.6),g8*n3*0.5);
  c=mix(c,mix(u_c1,u_c2,0.5),g9*n4*0.55);
  c=mix(c,mix(u_c3,u_c1,0.3),g10*n2*0.4);
  c=mix(c,mix(u_c1,u_c2,n3),smoothstep(0.45,0.8,n3)*0.22);
  float edge=smoothstep(0.4,0.52,n3)*smoothstep(0.62,0.52,n3);
  c+=vec3(1.0,0.98,0.95)*edge*0.1;
  vec2 vig=uv*(1.0-uv);
  c*=pow(vig.x*vig.y*16.0,0.1);
  gl_FragColor=vec4(c,1.0);
}`;

function useShaderCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>, fragSrc: string) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(prog);
    const timeLoc = gl.getUniformLocation(prog, "u_time");
    const resLoc = gl.getUniformLocation(prog, "u_res");
    const c0Loc = gl.getUniformLocation(prog, "u_c0");
    const c1Loc = gl.getUniformLocation(prog, "u_c1");
    const c2Loc = gl.getUniformLocation(prog, "u_c2");
    const c3Loc = gl.getUniformLocation(prog, "u_c3");

    const colors = readThemeColors();
    gl.uniform3fv(c0Loc, colors.appBg);
    gl.uniform3fv(c1Loc, colors.accent);
    gl.uniform3fv(c2Loc, colors.accentSoft);
    gl.uniform3fv(c3Loc, colors.panelSoft);

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (prefersReducedMotion) {
        gl.uniform1f(timeLoc, 0);
        gl.uniform2f(resLoc, canvas.width, canvas.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      gl.uniform1f(timeLoc, (performance.now() - t0) / 1000);
      gl.uniform2f(resLoc, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(tick);
    };
    if (prefersReducedMotion) {
      gl.uniform1f(timeLoc, 0);
      gl.uniform2f(resLoc, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [fragSrc]);
}

function RestrictedWarpBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useShaderCanvas(ref, WARP_FRAG);
  return (
    <>
      <canvas ref={ref} className="restricted-shader-canvas" />
      <div className="restricted-fluid-grain" />
      <div className="restricted-fluid-vignette" />
    </>
  );
}

function RestrictedWarpLegacyBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useShaderCanvas(ref, WARP_FRAG_LEGACY);
  return (
    <>
      <canvas ref={ref} className="restricted-shader-canvas" />
      <div className="restricted-fluid-grain" />
      <div className="restricted-fluid-vignette" />
    </>
  );
}

function RestrictedWavesBackground() {
  return (
    <>
      <svg className="restricted-fluid-svg restricted-fluid-svg-wave" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="restricted-wave-base" x1="6%" y1="6%" x2="94%" y2="92%">
            <stop offset="0%" stopColor="var(--app-bg)" />
            <stop offset="24%" stopColor="var(--buttons-bg)" />
            <stop offset="54%" stopColor="var(--panel-soft)" />
            <stop offset="78%" stopColor="var(--accent-soft)" stopOpacity="0.88" />
            <stop offset="100%" stopColor="var(--app-bg)" />
          </linearGradient>
          <radialGradient id="restricted-wave-light-a" cx="78%" cy="34%" r="58%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.58)" />
            <stop offset="34%" stopColor="var(--accent-soft)" stopOpacity="0.62" />
            <stop offset="100%" stopColor="var(--accent-soft)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="restricted-wave-light-b" cx="20%" cy="72%" r="64%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.46)" />
            <stop offset="40%" stopColor="var(--panel-soft)" stopOpacity="0.54" />
            <stop offset="100%" stopColor="var(--panel-soft)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="restricted-wave-ribbon-a" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="38%" stopColor="var(--accent-color)" stopOpacity="0.8" />
            <stop offset="62%" stopColor="rgba(255,255,255,0.64)" />
            <stop offset="100%" stopColor="var(--panel-soft)" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="restricted-wave-ribbon-b" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.04)" />
            <stop offset="42%" stopColor="var(--panel-soft)" stopOpacity="0.72" />
            <stop offset="74%" stopColor="var(--accent-soft)" stopOpacity="0.56" />
            <stop offset="100%" stopColor="var(--accent-color)" stopOpacity="0.3" />
          </linearGradient>
          <linearGradient id="restricted-wave-ribbon-c" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="48%" stopColor="var(--accent-soft)" stopOpacity="0.58" />
            <stop offset="100%" stopColor="var(--panel-soft)" stopOpacity="0.2" />
          </linearGradient>
          <linearGradient id="restricted-wave-contour" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--accent-soft)" stopOpacity="0.16" />
            <stop offset="40%" stopColor="rgba(255,255,255,0.66)" />
            <stop offset="66%" stopColor="rgba(255,255,255,0.52)" />
            <stop offset="100%" stopColor="var(--accent-soft)" stopOpacity="0.14" />
          </linearGradient>
          <filter id="restricted-wave-displace" x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.0032 0.0094" numOctaves="5" seed="14" result="noise">
              <animate
                attributeName="baseFrequency"
                dur="16s"
                values="0.0032 0.0094;0.0054 0.0122;0.0032 0.0094"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="92" xChannelSelector="R" yChannelSelector="B">
              <animate attributeName="scale" dur="14s" values="66;108;78;66" repeatCount="indefinite" />
            </feDisplacementMap>
          </filter>
          <filter id="restricted-wave-soft" x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="18" />
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1.25 0"
            />
          </filter>
          <filter id="restricted-wave-contour-soft" x="-35%" y="-35%" width="170%" height="170%">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
        </defs>
        <rect width="1600" height="1000" fill="var(--app-bg)" />
        <g filter="url(#restricted-wave-displace)" opacity="0.96">
          <rect x="-240" y="-180" width="2080" height="1360" fill="url(#restricted-wave-base)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 96 32; -60 92; 0 0"
              dur="24s"
              repeatCount="indefinite"
            />
          </rect>
          <path d="M-320 770 C 40 500 340 860 730 640 C 1000 488 1330 772 1920 560 L 1920 1180 L -320 1180 Z" fill="rgba(0,0,0,0.44)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -84 30; 56 -20; 0 0"
              dur="21s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M-360 520 C 80 330 440 640 860 460 C 1180 320 1490 520 1980 360 L 1980 860 L -360 860 Z" fill="rgba(0,0,0,0.3)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 72 -24; -46 18; 0 0"
              dur="19s"
              repeatCount="indefinite"
            />
          </path>
          <ellipse cx="1240" cy="290" rx="470" ry="310" fill="url(#restricted-wave-light-a)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -98 36; 60 -30; 0 0"
              dur="20s"
              repeatCount="indefinite"
            />
          </ellipse>
          <ellipse cx="250" cy="760" rx="520" ry="300" fill="url(#restricted-wave-light-b)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 92 -40; -58 30; 0 0"
              dur="22s"
              repeatCount="indefinite"
            />
          </ellipse>
        </g>
        <g fill="none" strokeLinecap="round" filter="url(#restricted-wave-soft)" opacity="0.9">
          <path
            d="M-320 620 C 30 260 470 800 840 430 C 1130 150 1360 560 1880 250"
            stroke="url(#restricted-wave-ribbon-a)"
            strokeWidth="156"
          >
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 92 -34; -62 28; 0 0"
              dur="19s"
              repeatCount="indefinite"
            />
          </path>
          <path
            d="M-320 820 C 100 440 500 960 920 590 C 1210 380 1510 760 1940 500"
            stroke="url(#restricted-wave-ribbon-b)"
            strokeWidth="128"
          >
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -78 42; 54 -30; 0 0"
              dur="21s"
              repeatCount="indefinite"
            />
          </path>
          <path
            d="M-340 470 C 100 180 500 620 870 310 C 1160 100 1460 370 1930 120"
            stroke="url(#restricted-wave-ribbon-c)"
            strokeWidth="104"
          >
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 70 -28; -50 22; 0 0"
              dur="17s"
              repeatCount="indefinite"
            />
          </path>
        </g>
        <g fill="none" stroke="url(#restricted-wave-contour)" strokeWidth="2.1" strokeLinecap="round" filter="url(#restricted-wave-contour-soft)" opacity="0.72">
          <path d="M-280 170 C 64 112 392 244 766 176 C 1072 118 1398 230 1908 144">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 48 -12; -30 10; 0 0"
              dur="13s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M-296 256 C 44 196 382 326 780 256 C 1112 198 1432 314 1920 226" strokeOpacity="0.62">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -40 14; 26 -11; 0 0"
              dur="15s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M-284 354 C 62 292 402 428 804 354 C 1138 292 1452 404 1938 322" strokeOpacity="0.56">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 36 -12; -24 10; 0 0"
              dur="17s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M-312 470 C 32 404 374 546 796 468 C 1148 406 1466 528 1950 444" strokeOpacity="0.5">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -34 12; 22 -9; 0 0"
              dur="19s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M-296 596 C 70 520 418 672 824 596 C 1164 534 1490 652 1978 566" strokeOpacity="0.44">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 30 -10; -20 8; 0 0"
              dur="21s"
              repeatCount="indefinite"
            />
          </path>
          <path d="M-340 730 C 50 648 438 812 868 736 C 1214 666 1552 790 2010 694" strokeOpacity="0.4">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -28 10; 18 -7; 0 0"
              dur="23s"
              repeatCount="indefinite"
            />
          </path>
        </g>
      </svg>
      <div className="restricted-wave-prism" />
      <div className="restricted-wave-sheen" />
      <div className="restricted-wave-rim" />
      <div className="restricted-fluid-grain" />
      <div className="restricted-fluid-vignette" />
    </>
  );
}

function RestrictedBubblesBackground() {
  return (
    <>
      <svg className="restricted-fluid-svg restricted-fluid-svg-main" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="restricted-fluid-mesh" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--buttons-bg)" />
            <stop offset="28%" stopColor="var(--accent-soft)" />
            <stop offset="56%" stopColor="var(--panel-soft)" />
            <stop offset="78%" stopColor="var(--accent-color)" stopOpacity="0.72" />
            <stop offset="100%" stopColor="var(--app-bg)" />
          </linearGradient>
          <radialGradient id="restricted-fluid-core" cx="34%" cy="32%" r="62%">
            <stop offset="0%" stopColor="var(--accent-color)" stopOpacity="0.72" />
            <stop offset="54%" stopColor="var(--accent-color)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="var(--accent-color)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="restricted-fluid-neon" cx="70%" cy="64%" r="60%">
            <stop offset="0%" stopColor="var(--panel-soft)" stopOpacity="0.92" />
            <stop offset="48%" stopColor="var(--panel-soft)" stopOpacity="0.42" />
            <stop offset="100%" stopColor="var(--panel-soft)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="restricted-fluid-ribbon-a" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--accent-soft)" stopOpacity="0.06" />
            <stop offset="42%" stopColor="var(--accent-color)" stopOpacity="0.54" />
            <stop offset="100%" stopColor="var(--panel-soft)" stopOpacity="0.08" />
          </linearGradient>
          <linearGradient id="restricted-fluid-ribbon-b" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--panel-soft)" stopOpacity="0.08" />
            <stop offset="45%" stopColor="var(--accent-soft)" stopOpacity="0.58" />
            <stop offset="100%" stopColor="var(--accent-color)" stopOpacity="0.2" />
          </linearGradient>
          <filter id="restricted-fluid-displace" x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.0038 0.0105" numOctaves="4" seed="29" result="noise">
              <animate
                attributeName="baseFrequency"
                dur="20s"
                values="0.0038 0.0105;0.006 0.014;0.0038 0.0105"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="80" xChannelSelector="R" yChannelSelector="G">
              <animate attributeName="scale" dur="16s" values="58;96;72;58" repeatCount="indefinite" />
            </feDisplacementMap>
          </filter>
          <filter id="restricted-fluid-goo" x="-35%" y="-35%" width="170%" height="170%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="18" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -11"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
          <filter id="restricted-fluid-bloom" x="-35%" y="-35%" width="170%" height="170%">
            <feGaussianBlur stdDeviation="24" />
          </filter>
        </defs>
        <rect width="1600" height="1000" fill="var(--app-bg)" />
        <g filter="url(#restricted-fluid-displace)" opacity="0.94">
          <rect x="-260" y="-200" width="2120" height="1400" fill="url(#restricted-fluid-mesh)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 92 32; -54 86; 0 0"
              dur="28s"
              repeatCount="indefinite"
            />
          </rect>
          <ellipse cx="380" cy="220" rx="520" ry="340" fill="url(#restricted-fluid-core)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 84 24; -62 64; 0 0"
              dur="24s"
              repeatCount="indefinite"
            />
          </ellipse>
          <ellipse cx="1220" cy="760" rx="560" ry="360" fill="url(#restricted-fluid-neon)">
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -92 -42; 60 -80; 0 0"
              dur="30s"
              repeatCount="indefinite"
            />
          </ellipse>
        </g>
        <g filter="url(#restricted-fluid-bloom)" opacity="0.56">
          <path
            d="M-260 570 C 120 290 390 760 730 500 C 980 300 1220 690 1860 440 L 1860 1160 L -260 1160 Z"
            fill="url(#restricted-fluid-ribbon-a)"
          >
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; 96 -42; -68 34; 0 0"
              dur="20s"
              repeatCount="indefinite"
            />
          </path>
          <path
            d="M-300 440 C 60 180 280 580 620 360 C 880 190 1100 520 1730 320 L 1730 1020 L -300 1020 Z"
            fill="url(#restricted-fluid-ribbon-b)"
          >
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 0; -78 46; 56 -32; 0 0"
              dur="24s"
              repeatCount="indefinite"
            />
          </path>
        </g>
        <g filter="url(#restricted-fluid-goo)" opacity="0.54">
          <circle cx="300" cy="230" r="160" fill="var(--accent-soft)">
            <animate attributeName="cx" dur="30s" values="300;620;240;300" repeatCount="indefinite" />
            <animate attributeName="cy" dur="22s" values="230;200;390;230" repeatCount="indefinite" />
            <animate attributeName="r" dur="26s" values="160;220;150;160" repeatCount="indefinite" />
          </circle>
          <circle cx="970" cy="350" r="180" fill="var(--panel-soft)">
            <animate attributeName="cx" dur="26s" values="970;1180;860;970" repeatCount="indefinite" />
            <animate attributeName="cy" dur="24s" values="350;470;260;350" repeatCount="indefinite" />
            <animate attributeName="r" dur="20s" values="180;230;170;180" repeatCount="indefinite" />
          </circle>
          <circle cx="1260" cy="770" r="210" fill="var(--accent-soft)">
            <animate attributeName="cx" dur="34s" values="1260;1040;1420;1260" repeatCount="indefinite" />
            <animate attributeName="cy" dur="28s" values="770;690;860;770" repeatCount="indefinite" />
            <animate attributeName="r" dur="24s" values="210;280;200;210" repeatCount="indefinite" />
          </circle>
          <circle cx="650" cy="740" r="170" fill="var(--buttons-bg)">
            <animate attributeName="cx" dur="32s" values="650;820;560;650" repeatCount="indefinite" />
            <animate attributeName="cy" dur="22s" values="740;600;820;740" repeatCount="indefinite" />
            <animate attributeName="r" dur="27s" values="170;225;155;170" repeatCount="indefinite" />
          </circle>
        </g>
      </svg>
      <div className="restricted-fluid-caustic" />
      <div className="restricted-fluid-ring restricted-fluid-ring-a" />
      <div className="restricted-fluid-ring restricted-fluid-ring-b" />
      <div className="restricted-fluid-glow restricted-fluid-glow-a" />
      <div className="restricted-fluid-glow restricted-fluid-glow-b" />
      <div className="restricted-fluid-grain" />
      <div className="restricted-fluid-vignette" />
    </>
  );
}

export function PasswordScreen() {
  const t = useTr();
  const store = useStore();
  const [password, setPassword] = useState("");
  const [retryFailed, setRetryFailed] = useState(false);
  const restrictedBackgroundStyle = normalizeRestrictedBackgroundStyle(store.settings?.General?.RestrictedBackgroundStyle);

  const handleRetryAutoUnlock = async () => {
    setRetryFailed(false);
    const unlocked = await store.retryAutoUnlock();
    if (!unlocked) setRetryFailed(true);
  };

  return (
    <div className="theme-app relative flex h-screen flex-col items-center justify-center overflow-hidden px-6 py-8">
      <div className="restricted-fluid-bg" aria-hidden>
        {restrictedBackgroundStyle === "bubbles"
          ? <RestrictedBubblesBackground />
          : restrictedBackgroundStyle === "warpLegacy"
            ? <RestrictedWarpLegacyBackground />
          : restrictedBackgroundStyle === "warp"
            ? <RestrictedWarpBackground />
            : <RestrictedWavesBackground />}
      </div>
      <ModalWindowControls visible />
      <div className="restricted-auth-shell relative z-10 w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1
            className="restricted-auth-title text-xl font-semibold text-[var(--panel-fg)] animate-fade-in-up"
            style={{ animationDelay: "0.05s" }}
          >
            {t("Restricted Access")}
          </h1>
          <p className="restricted-auth-subtitle mt-2 text-sm theme-muted animate-fade-in-up" style={{ animationDelay: "0.1s" }}>
            {t("Enter your password to continue")}
          </p>
        </div>

        <div
          className="restricted-auth-card theme-panel theme-border rounded-xl border p-6 shadow-2xl backdrop-blur-lg animate-fade-in-up"
          style={{ animationDelay: "0.2s" }}
        >
          {store.error && (
            <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-sm text-red-400 animate-fade-in">
              {store.error}
            </div>
          )}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && store.unlock(password)}
            placeholder={t("Password")}
            className="restricted-auth-input theme-input mb-4 w-full rounded-lg px-4 py-2.5 text-sm focus:outline-none transition-colors"
            autoFocus
          />
          <button
            onClick={() => store.unlock(password)}
            disabled={store.unlocking || !password}
            className="restricted-auth-btn theme-btn w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {store.unlocking ? t("Unlocking...") : t("Continue")}
          </button>
          <button
            onClick={handleRetryAutoUnlock}
            disabled={store.unlocking}
            className="theme-btn-ghost mt-3 w-full rounded-lg px-4 py-2 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("Try automatic unlock again")}
          </button>
          {retryFailed && (
            <div className="mt-3 rounded-lg bg-amber-500/10 border border-amber-500/20 px-4 py-2.5 text-xs text-amber-400 animate-fade-in">
              {t("Automatic unlock is still not possible")}
            </div>
          )}
          <p className="mt-4 text-xs theme-muted leading-relaxed">
            {t("Never set a password? Your device identity may have changed, for example after MachineGuid spoofing. Restore your device identity in the Isolation settings, then retry the automatic unlock")}
          </p>
        </div>
      </div>
    </div>
  );
}
