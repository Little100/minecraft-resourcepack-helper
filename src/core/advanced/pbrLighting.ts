// 直接光使用GGX，天空与地面的解析反射提供可调的基础环境
export const PBR_LIGHTING_GLSL = `
uniform vec3 uSunDirection;
uniform float uAmbientIntensity;
uniform float uEnvironmentIntensity;
uniform float uExposure;
float mcrhShadowMask() { return 1.0; }
vec3 mcrhShadePbr(vec3 base, vec3 N, vec3 V, float roughness, float metallic, float ao) {
  vec3 L = normalize((viewMatrix * vec4(normalize(uSunDirection), 0.0)).xyz);
  vec3 H = normalize(L + V + vec3(0.000001));
  float nv = max(dot(N, V), 0.0001), nl = max(dot(N, L), 0.0);
  float nh = max(dot(N, H), 0.0), vh = max(dot(V, H), 0.0);
  float a = max(roughness * roughness, 0.0025), a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / max(3.14159265 * d * d, 0.0000001);
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  float geometry = nv / (nv * (1.0 - k) + k) * nl / max(nl * (1.0 - k) + k, 0.0001);
  vec3 f0 = mix(vec3(0.04), base, metallic);
  vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  vec3 specular = distribution * geometry * fresnel / max(4.0 * nv * max(nl, 0.0001), 0.0001);
  vec3 diffuse = (1.0 - fresnel) * (1.0 - metallic) * base / 3.14159265;
  vec3 direct = (diffuse + specular) * nl * max(uSunIntensity, 0.0) * mcrhShadowMask();
  vec3 worldNormal = normalize(vec3(dot(viewMatrix[0].xyz, N), dot(viewMatrix[1].xyz, N), dot(viewMatrix[2].xyz, N)));
  vec3 reflected = reflect(-V, N);
  vec3 worldReflection = vec3(dot(viewMatrix[0].xyz, reflected), dot(viewMatrix[1].xyz, reflected), dot(viewMatrix[2].xyz, reflected));
  float sky = clamp(worldReflection.y * (1.0 - roughness) * 0.5 + 0.5, 0.0, 1.0);
  vec3 environment = mix(vec3(0.12, 0.10, 0.09), vec3(0.65, 0.78, 1.0), sky);
  vec3 ambientFresnel = f0 + (max(vec3(1.0 - roughness), f0) - f0) * pow(1.0 - nv, 5.0);
  vec3 ambient = base * (1.0 - metallic) * max(uAmbientIntensity, 0.0) * (0.65 + 0.35 * max(worldNormal.y, 0.0));
  ambient += environment * ambientFresnel * max(uEnvironmentIntensity, 0.0) * (1.0 - 0.65 * roughness);
  return direct + ambient * ao;
}
`
