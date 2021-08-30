
import { mat4, ReadonlyMat4 } from "gl-matrix";
import { CameraController } from "../Camera";
import { Color, colorCopy, colorNewCopy, colorNewFromRGBA, colorScale, White } from "../Color";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxShaderLibrary } from "../gfx/helpers/ShaderHelpers";
import { fillColor, fillMatrix4x3, fillMatrix4x4, fillVec3v, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBlendMode, GfxCullMode, GfxDevice, GfxMegaStateDescriptor, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxProgram, GfxSampler } from "../gfx/platform/GfxPlatformImpl";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { GfxRendererLayer, GfxRenderInst, GfxRenderInstManager, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { setMatrixTranslation } from "../MathHelpers";
import { DeviceProgram } from "../Program";
import { TextureMapping } from "../TextureHolder";
import { nArray } from "../util";
import { SceneGfx, ViewerRenderInput } from "../viewer";
import { Asset_Type, Material_Flags, Material_Type, Mesh_Asset, Render_Material, Texture_Asset } from "./Assets";
import { Lightmap_Table } from "./Entity";
import { TheWitnessGlobals } from "./Globals";

class TheWitnessProgram extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_ObjectParams = 1;

    public both = `
layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ViewProjection;
    vec4 u_CameraPosWorld;
    vec4 u_KeyLightDir;
    vec4 u_KeyLightColor;
};

layout(std140) uniform ub_ObjectParams {
    Mat4x3 u_ModelMatrix;
    vec4 u_MaterialColorAndEmission;
    vec4 u_FoliageParams;
    vec4 u_Misc[1];

    // Terrain Tint System
    vec4 u_TerrainScaleBias;
    vec4 u_TintFactor;
    vec4 u_AverageColor[3];
};

#define u_BlendFactor    (u_Misc[0].x)
#define u_LightMap0Blend (u_Misc[0].y)
#define u_LightMap1Blend (u_Misc[0].z)

uniform sampler2D u_TextureMap0;
uniform sampler2D u_TextureMap1;
uniform sampler2D u_TextureMap2;

uniform sampler2D u_NormalMap0;
uniform sampler2D u_NormalMap1;
uniform sampler2D u_NormalMap2;

uniform sampler2D u_BlendMap0;
uniform sampler2D u_BlendMap1;
uniform sampler2D u_BlendMap2;

uniform sampler2D u_LightMap0;
uniform sampler2D u_LightMap1;

uniform sampler2D u_TerrainColor;

vec2 CalcScaleBias(in vec2 t_Pos, in vec4 t_SB) {
    return t_Pos.xy * t_SB.xy + t_SB.zw;
}

vec3 UnpackNormalMap(in vec4 t_NormalMapSample) {
    vec3 t_Normal;

    t_Normal.x = dot(t_NormalMapSample.xx, t_NormalMapSample.ww) - 1.0;
    t_Normal.y = t_NormalMapSample.y * 2.0 - 1.0;
    t_Normal.z = 1.0 - dot(t_Normal.xy, t_Normal.xy);

    return t_Normal;
}

vec3 CalcNormalWorld(in vec3 t_MapNormal, in vec3 t_Basis0, in vec3 t_Basis1, in vec3 t_Basis2) {
    return t_MapNormal.xxx * t_Basis0 + t_MapNormal.yyy * t_Basis1 * t_MapNormal.zzz * t_Basis2;
}

vec3 UnpackLightMapSample(in vec4 t_Sample) {
    vec3 t_Color = t_Sample.rgb * ((t_Sample.a * 0.85) + 0.15);
    t_Color *= t_Color;
    return t_Color;
}

vec3 CalcLightMapColor(in vec2 t_TexCoord) {
    vec3 t_LightMapSample = vec3(0.0);
    if (u_LightMap0Blend > 0.0)
        t_LightMapSample += UnpackLightMapSample(texture(SAMPLER_2D(u_LightMap0), t_TexCoord.xy)) * u_LightMap0Blend;
    if (u_LightMap1Blend > 0.0)
        t_LightMapSample += UnpackLightMapSample(texture(SAMPLER_2D(u_LightMap1), t_TexCoord.xy)) * u_LightMap1Blend;
    return t_LightMapSample;
}
`;

    public vert = `
precision mediump float;

layout(location = 0) in vec4 a_Position;
layout(location = 1) in vec2 a_TexCoord0;
layout(location = 2) in vec2 a_TexCoord1;
layout(location = 3) in vec3 a_Normal;
layout(location = 4) in vec4 a_TangentS;
layout(location = 5) in vec4 a_Color0;
layout(location = 6) in vec4 a_Color1;
layout(location = 7) in vec4 a_BlendIndices;
layout(location = 8) in vec4 a_BlendWeights;

out vec2 v_TexCoord0;
out vec3 v_LightMapData;
out vec4 v_Color0;
out vec3 v_PositionWorld;

// TBN
out vec3 v_TangentSpaceBasis0;
out vec3 v_TangentSpaceBasis1;
out vec3 v_TangentSpaceBasis2;

void main() {
    v_PositionWorld = Mul(_Mat4x4(u_ModelMatrix), vec4(a_Position.xyz, 1.0)).xyz;
    gl_Position = Mul(u_ViewProjection, vec4(v_PositionWorld, 1.0));
    v_TexCoord0 = a_TexCoord0.xy;

    vec3 t_NormalWorld = a_Normal;
    vec3 t_TangentSWorld = a_TangentS.xyz;
    vec3 t_TangentTWorld = cross(t_NormalWorld, t_TangentSWorld);

    v_TangentSpaceBasis0 = t_TangentSWorld * sign(a_TangentS.w);
    v_TangentSpaceBasis1 = t_TangentTWorld;
    v_TangentSpaceBasis2 = t_NormalWorld;
    v_Color0 = a_Color0;

    bool use_vertex_lightmap = ${this.is_flag(Material_Flags.Vertex_Lightmap | Material_Flags.Vertex_Lightmap_Auto)};
    if (use_vertex_lightmap) {
        v_LightMapData = CalcLightMapColor(a_TexCoord1.xy);
    } else {
        v_LightMapData = vec3(a_TexCoord1.xy, 0.0);
    }
}
`;

    public frag = `
in vec2 v_TexCoord0;
in vec3 v_LightMapData;
in vec4 v_Color0;
in vec3 v_PositionWorld;

in vec3 v_TangentSpaceBasis0;
in vec3 v_TangentSpaceBasis1;
in vec3 v_TangentSpaceBasis2;

${GfxShaderLibrary.saturate}

vec3 CalcBlendWeight2(in vec2 t_TexCoord, in vec4 t_Blend, in float t_BlendRange) {
    float t_Blend0 = t_Blend.w - texture(SAMPLER_2D(u_BlendMap0), t_TexCoord.xy).x;
    float t_Weight0 = t_Blend0 * t_BlendRange + 0.5;

    vec3 t_BlendWeight;
    t_BlendWeight.x = (1.0 - t_Weight0);
    t_BlendWeight.y = t_Weight0;
    t_BlendWeight.z = 0.0;
    return t_BlendWeight;
}

vec3 CalcBlendWeight3(in vec2 t_TexCoord, in vec4 t_Blend, in float t_BlendRange) {
    float t_Blend0 = t_Blend.x * texture(SAMPLER_2D(u_BlendMap0), t_TexCoord.xy).x;
    float t_Blend1 = t_Blend.y * texture(SAMPLER_2D(u_BlendMap1), t_TexCoord.xy).x;
    float t_Blend2 = t_Blend.z * texture(SAMPLER_2D(u_BlendMap2), t_TexCoord.xy).x;

    float t_Weight0 = saturate(((t_Blend1 - t_Blend0) / (t_Blend0 + t_Blend1)) * t_BlendRange + 0.5);
    float t_BlendM = max(t_Blend0, t_Blend1);
    float t_Weight1 = saturate(((t_Blend2 - t_BlendM) / (t_BlendM + t_Blend2)) * t_BlendRange + 0.5);

    vec3 t_BlendWeight;
    t_BlendWeight.x = (1.0 - t_Weight0) * (1.0 - t_Weight1);
    t_BlendWeight.y = t_Weight0 * (1.0 - t_Weight1);
    t_BlendWeight.z = t_Weight1;
    return t_BlendWeight;
}

vec3 CalcBlendWeightAlbedo(in vec2 t_TexCoord, in vec4 t_Blend, in float t_BlendRange) {
    bool type_blended = ${this.is_type(Material_Type.Blended)};
    bool type_blended3 = ${this.is_type(Material_Type.Blended3)};

    if (type_blended3) {
        return CalcBlendWeight3(t_TexCoord, t_Blend, t_BlendRange);
    } else if (type_blended) {
        return CalcBlendWeight2(t_TexCoord, t_Blend, t_BlendRange);
    } else {
        return vec3(1.0, 0.0, 0.0);
    }
}

vec3 CalcBlendWeightNormal(in vec2 t_TexCoord, in vec4 t_Blend, in float t_BlendRange) {
    bool type_blended3 = ${this.is_type(Material_Type.Blended3)};

    if (type_blended3) {
        return CalcBlendWeight3(t_TexCoord, t_Blend, t_BlendRange);
    } else {
        return vec3(1.0, 0.0, 0.0);
    }
}

float HalfLambert(in float t_Dot) {
    return saturate(t_Dot) * 0.5 + 0.5;
}

vec4 TintTexture(in vec4 t_Sample, in vec3 t_TintColor, in vec3 t_AverageColor, in float t_TintAmount) {
    vec3 t_TintedColor = t_TintColor.rgb * (t_Sample.rgb / t_AverageColor.rgb);
    t_Sample.rgb = mix(t_Sample.rgb, t_TintedColor.rgb, t_TintAmount);
    return t_Sample;
}

vec4 SampleTerrain() {
    vec2 t_TerrainTexCoord = CalcScaleBias(v_PositionWorld.xy, u_TerrainScaleBias);
    return texture(SAMPLER_2D(u_TerrainColor), t_TerrainTexCoord);
}

vec4 TintTerrain(in vec4 t_Sample, in vec3 t_AverageColor, in float t_TintAmount) {
    bool use_terrain_tint = ${this.is_type(Material_Type.Blended3) || this.is_type(Material_Type.Tinted) || this.is_type(Material_Type.Decal)};

    if (use_terrain_tint) {
        vec3 t_TerrainColor = SampleTerrain().rgb;
        return TintTexture(t_Sample, t_TerrainColor, t_AverageColor, t_TintAmount);
    } else {
        return t_Sample;
    }
}

vec4 CalcAlbedo() {
    vec2 t_TexCoord0 = v_TexCoord0.xy;
    vec3 t_BlendWeightAlbedo = CalcBlendWeightAlbedo(t_TexCoord0.xy, v_Color0.rgba, u_BlendFactor);
    vec4 t_Albedo = vec4(0.0);
    if (t_BlendWeightAlbedo.x > 0.0)
        t_Albedo += TintTerrain(texture(SAMPLER_2D(u_TextureMap0), t_TexCoord0.xy), u_AverageColor[0].rgb, u_TintFactor.x) * t_BlendWeightAlbedo.x;
    if (t_BlendWeightAlbedo.y > 0.0)
        t_Albedo += TintTerrain(texture(SAMPLER_2D(u_TextureMap1), t_TexCoord0.xy), u_AverageColor[1].rgb, u_TintFactor.y) * t_BlendWeightAlbedo.y;
    if (t_BlendWeightAlbedo.z > 0.0)
        t_Albedo += TintTerrain(texture(SAMPLER_2D(u_TextureMap2), t_TexCoord0.xy), u_AverageColor[2].rgb, u_TintFactor.z) * t_BlendWeightAlbedo.z;
    return t_Albedo;
}

vec3 CalcNormalMap() {
    vec2 t_TexCoord0 = v_TexCoord0.xy;
    vec3 t_BlendWeightNormal = CalcBlendWeightNormal(t_TexCoord0.xy, v_Color0.rgba, u_BlendFactor);
    vec3 t_NormalMapSample = vec3(0.0);
    if (t_BlendWeightNormal.x > 0.0)
        t_NormalMapSample += UnpackNormalMap(texture(SAMPLER_2D(u_NormalMap0), t_TexCoord0.xy)) * t_BlendWeightNormal.x;
    if (t_BlendWeightNormal.y > 0.0)
        t_NormalMapSample += UnpackNormalMap(texture(SAMPLER_2D(u_NormalMap1), t_TexCoord0.xy)) * t_BlendWeightNormal.y;
    if (t_BlendWeightNormal.z > 0.0)
        t_NormalMapSample += UnpackNormalMap(texture(SAMPLER_2D(u_NormalMap2), t_TexCoord0.xy)) * t_BlendWeightNormal.z;
    return t_NormalMapSample;
}

void main() {
    vec2 t_TexCoord0 = v_TexCoord0.xy;

    vec3 t_PositionToEye = u_CameraPosWorld.xyz - v_PositionWorld.xyz;
    vec3 t_WorldDirectionToEye = normalize(t_PositionToEye);

    vec4 t_Albedo = CalcAlbedo();
    vec3 t_NormalMapSample = CalcNormalMap();
    vec3 t_NormalWorld = CalcNormalWorld(t_NormalMapSample, v_TangentSpaceBasis0, v_TangentSpaceBasis1, v_TangentSpaceBasis2);
    vec3 t_NormalWorldSurface = normalize(v_TangentSpaceBasis2);

    t_Albedo.rgb *= u_MaterialColorAndEmission.rgb;

    vec3 t_DiffuseLight = vec3(1.0);

    bool use_lightmap = ${this.is_flag(Material_Flags.Lightmapped)};
    if (use_lightmap) {
        bool use_vertex_lightmap = ${this.is_flag(Material_Flags.Vertex_Lightmap | Material_Flags.Vertex_Lightmap_Auto)};

        vec3 t_LightMapSample;
        if (use_vertex_lightmap) {
            t_LightMapSample = v_LightMapData.xyz;
        } else {
            t_LightMapSample = CalcLightMapColor(v_LightMapData.xy);
        }

        // This should only happen on "standard" indirect shading; I think...
        t_LightMapSample *= HalfLambert(dot(t_NormalWorld, t_NormalWorldSurface));

        t_DiffuseLight = t_LightMapSample;

        // TODO(jstpierre): Sun directional?
    }

    bool use_cloud = ${this.is_type(Material_Type.Cloud)};
    if (use_cloud) {
        float t_Wrap = u_FoliageParams.x;
        float t_Dot = saturate((dot(t_NormalWorld.xyz, u_KeyLightDir.xyz) + t_Wrap) / (t_Wrap + 1.0));

        float t_Scatter = saturate(-10.0 * 0.9 + dot(t_WorldDirectionToEye.xyz, u_KeyLightDir.xyz));
        float t_Occlusion = saturate(1.75 - abs(dot(t_NormalWorld.xyz, u_KeyLightDir.xyz)));

        t_Dot += pow(t_Scatter * t_Occlusion, 4.0);

        t_DiffuseLight = vec3(0.0);
        t_DiffuseLight.rgb += (0.78 * t_Dot * u_KeyLightColor.rgb);
        t_DiffuseLight.rgb += vec3(2.496, 4.68, 2.64);
    }

    float t_Emission = u_MaterialColorAndEmission.a;
    t_DiffuseLight.rgb += vec3(t_Emission);

    vec3 t_FinalColor = vec3(0.0);
    t_FinalColor.rgb += t_DiffuseLight.rgb * t_Albedo.rgb;

    // Gamma correct
    t_FinalColor = pow(t_FinalColor, vec3(1.0 / 2.2));

    float t_Alpha = 1.0;
    bool use_albedo_alpha = ${this.is_type(Material_Type.Vegetation) || this.is_type(Material_Type.Foliage) || this.is_type(Material_Type.Translucent) || this.is_type(Material_Type.Cloud)};
    if (use_albedo_alpha) {
        t_Alpha *= t_Albedo.a;
    }

    bool use_decal_alpha = ${this.is_type(Material_Type.Decal)};
    if (use_decal_alpha) {
        float t_Blend0 = texture(SAMPLER_2D(u_BlendMap0), t_TexCoord0.xy).x;
        float t_BlendFactor = saturate(v_Color0.r + (((v_Color0.r + t_Blend0) - 1.0) * u_BlendFactor));
        t_Alpha *= t_BlendFactor;
    }

    bool use_alpharef = ${this.is_type(Material_Type.Vegetation) || this.is_type(Material_Type.Foliage)};
    if (use_alpharef) {
        if (t_Alpha < 0.5)
            discard;
    }

    gl_FragColor = vec4(t_FinalColor.rgb, t_Alpha);
}
`;

    constructor(private render_material: Render_Material) {
        super();
    }

    private is_type(type: Material_Type): boolean {
        return this.render_material.material_type === type;
    }

    private is_flag(flag: Material_Flags): boolean {
        return !!(this.render_material.flags & flag);
    }
}

interface Material_Params {
    lightmap_table: Lightmap_Table | null;
    model_matrix: ReadonlyMat4;
    color: Color | null;
}

function material_will_dynamically_override_color(type: Material_Type, flags: Material_Flags): boolean {
    if (!!(flags & Material_Flags.Dynamic_Substitute)) {
        if (type === Material_Type.Standard)
            return true;
        if (type === Material_Type.Blended)
            return true;
        if (type === Material_Type.Hedge)
            return true;
        if (type === Material_Type.Blended3)
            return true;
        if (type === Material_Type.Tinted)
            return true;
        if (type === Material_Type.Decal)
            return true;
        if (type === Material_Type.Puzzle)
            return true;
        if (type === Material_Type.Foam_Decal)
            return true;
        if (type === Material_Type.Underwater)
            return true;
    } else {
        if (type === Material_Type.Foliage)
            return true;
        if (type === Material_Type.Vegetation)
            return true;
    }

    return false;
}

const scratchColor = colorNewCopy(White);
const scratchAABB = new AABB();
class Device_Material {
    public visible: boolean = true;

    private program: TheWitnessProgram;
    private gfx_program: GfxProgram;
    private texture_map: (Texture_Asset | null)[] = nArray(3, () => null);
    private texture_mapping_array: TextureMapping[] = nArray(12, () => new TextureMapping());

    public sortKeyBase = 0;
    public megaStateFlags: Partial<GfxMegaStateDescriptor> = {};

    constructor(globals: TheWitnessGlobals, private render_material: Render_Material) {
        const wrap_sampler = globals.cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Linear,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat,
        });

        const clamp_sampler = globals.cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Linear,
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp,
        });

        for (let i = 0; i < 3; i++)
            this.texture_map[i] = this.load_texture(globals, 0 + i, this.render_material.texture_map_names[i], wrap_sampler);
        for (let i = 0; i < 3; i++)
            this.load_texture(globals, 3 + i, this.render_material.normal_map_names[i], wrap_sampler);
        for (let i = 0; i < 3; i++)
            this.load_texture(globals, 6 + i, this.render_material.blend_map_names[i], wrap_sampler);

        const material_type = this.render_material.material_type;

        // 9, 10 are LightMap0 / LightMap1. By default, fill with white...
        this.load_texture(globals, 9, 'white', clamp_sampler);
        this.load_texture(globals, 10, 'white', clamp_sampler);

        if (material_type === Material_Type.Blended3 || material_type === Material_Type.Tinted || material_type === Material_Type.Decal)
            this.load_texture(globals, 11, 'color_map', clamp_sampler);

        this.program = new TheWitnessProgram(this.render_material);
        this.gfx_program = globals.asset_manager.cache.createProgram(this.program);

        // Disable invisible material types.
        if (material_type === Material_Type.Collision_Only || material_type === Material_Type.Occluder)
            this.visible = false;

        // This should go in the foam decal pass only...
        if (material_type === Material_Type.Foam_Decal)
            this.visible = false;

        let translucent = false;
        if (material_type === Material_Type.Translucent || material_type === Material_Type.Decal || material_type === Material_Type.Cloud)
            translucent = true;

        if (translucent) {
            this.sortKeyBase = makeSortKey(GfxRendererLayer.TRANSLUCENT, this.gfx_program.ResourceUniqueId);
            setAttachmentStateSimple(this.megaStateFlags, {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: GfxBlendFactor.SrcAlpha,
                blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
            });
            this.megaStateFlags.depthWrite = false;
        } else {
            this.sortKeyBase = makeSortKey(GfxRendererLayer.OPAQUE, this.gfx_program.ResourceUniqueId);
        }

        this.megaStateFlags.cullMode = GfxCullMode.Back;

        if (material_type === Material_Type.Foliage || material_type === Material_Type.Vegetation)
            this.megaStateFlags.cullMode = GfxCullMode.None;
    }

    private load_texture(globals: TheWitnessGlobals, i: number, texture_name: string | null, gfxSampler: GfxSampler): Texture_Asset | null {
        this.texture_mapping_array[i].gfxSampler = gfxSampler;
        if (texture_name === null)
            return null;
        const texture = globals.asset_manager.load_asset(Asset_Type.Texture, texture_name);
        if (texture !== null)
            texture.fillTextureMapping(this.texture_mapping_array[i]);
        return texture;
    }

    public fillMaterialParams(renderInst: GfxRenderInst, params: Material_Params): void {
        let offs = renderInst.allocateUniformBuffer(TheWitnessProgram.ub_ObjectParams, 4*4+4*8);
        const d = renderInst.mapUniformBufferF32(TheWitnessProgram.ub_ObjectParams);
        offs += fillMatrix4x3(d, offs, params.model_matrix);

        let lightmap0Blend = 1, lightmap1Blend = 0;
        if (params.lightmap_table !== null && params.lightmap_table.current_page !== null) {
            lightmap0Blend = params.lightmap_table.blend;
            lightmap1Blend = 1.0 - params.lightmap_table.blend;

            lightmap0Blend *= params.lightmap_table.current_page.color_range;
            if (params.lightmap_table.next_page !== null)
                lightmap0Blend *= params.lightmap_table.next_page.color_range;
        }

        const emission_scale = 10.0;

        if (params.color !== null && material_will_dynamically_override_color(this.render_material.material_type, this.render_material.flags)) {
            if (this.render_material.material_type === Material_Type.Vegetation && this.texture_map[0] !== null) {
                colorCopy(scratchColor, params.color);
                scratchColor.r /= this.texture_map[0].average_color.r;
                scratchColor.g /= this.texture_map[0].average_color.g;
                scratchColor.b /= this.texture_map[0].average_color.b;
                offs += fillColor(d, offs, scratchColor, scratchColor.a * emission_scale);
            } else {
                offs += fillColor(d, offs, params.color, params.color.a * emission_scale);
            }
        } else {
            offs += fillColor(d, offs, this.render_material.color, this.render_material.color.a * emission_scale);
        }

        offs += fillVec4v(d, offs, this.render_material.foliage_parameters);

        const blendFactor = 1.0 / this.render_material.blend_ranges[0];
        offs += fillVec4(d, offs, blendFactor, lightmap0Blend, lightmap1Blend);

        // Terrain Tint System

        // These come from All.variables.raw -- maybe we should parse these out eventually.
        const terrain_scale = 0.001395089285714;
        const terrain_offset_x = 0.5460377;
        const terrain_offset_y = 0.4347101;

        const map_scale_x = terrain_scale;
        const map_scale_y = 0.5 * terrain_scale;
        const map_offset_x = terrain_offset_x;
        const map_offset_y = 0.5 * ((!!(this.render_material.flags & Material_Flags.Alternate_Map) ? 0 : 1) + terrain_offset_y);
        offs += fillVec4(d, offs, map_scale_x, map_scale_y, map_offset_x, map_offset_y);

        offs += fillVec4v(d, offs, this.render_material.tint_factors);

        for (let i = 0; i < this.texture_map.length; i++) {
            if (this.texture_map[i] !== null)
                offs += fillColor(d, offs, this.texture_map[i]!.average_color);
            else
                offs += fillVec4(d, offs, 0);
        }
    }

    public setOnRenderInst(renderInst: GfxRenderInst, params: Material_Params): void {
        if (params.lightmap_table !== null && params.lightmap_table.current_page !== null) {
            params.lightmap_table.current_page.fillTextureMapping(this.texture_mapping_array[9]);
            if (params.lightmap_table.next_page !== null)
                params.lightmap_table.next_page.fillTextureMapping(this.texture_mapping_array[10]);
        }

        renderInst.sortKey = this.sortKeyBase;
        renderInst.setGfxProgram(this.gfx_program);
        renderInst.setMegaStateFlags(this.megaStateFlags);
        renderInst.setSamplerBindingsFromTextureMappings(this.texture_mapping_array);
    }
}

export class Mesh_Instance {
    private device_material_array: Device_Material[] = [];

    constructor(globals: TheWitnessGlobals, public mesh_asset: Mesh_Asset) {
        for (let i = 0; i < this.mesh_asset.material_array.length; i++)
            this.device_material_array.push(new Device_Material(globals, this.mesh_asset.material_array[i]));
    }

    public prepareToRender(globals: TheWitnessGlobals, renderInstManager: GfxRenderInstManager, params: Material_Params, depth: number): void {
        // Choose LOD level.
        const detail_level = 0;

        scratchAABB.transform(this.mesh_asset.box, params.model_matrix);
        if (!globals.viewpoint.frustum.contains(scratchAABB))
            return;

        for (let i = 0; i < this.mesh_asset.device_mesh_array.length; i++) {
            const device_mesh = this.mesh_asset.device_mesh_array[i];
            if (device_mesh.detail_level !== detail_level)
                continue;

            const device_material = this.device_material_array[device_mesh.material_index];
            if (!device_material.visible)
                continue;

            const renderInst = renderInstManager.newRenderInst();
            device_mesh.setOnRenderInst(renderInst);
            device_material.setOnRenderInst(renderInst, params);
            device_material.fillMaterialParams(renderInst, params);
            renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, depth);
            renderInstManager.submitRenderInst(renderInst);
        }
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 12, },
];

class Skydome {
    public lightmap_table: Lightmap_Table | null = null;
    public color: Color = colorNewFromRGBA(0.213740, 0.404580, 0.519084);
    public model_matrix = mat4.create();

    private mesh_instance: Mesh_Instance;

    constructor(globals: TheWitnessGlobals) {
        this.mesh_instance = new Mesh_Instance(globals, globals.asset_manager.load_asset(Asset_Type.Mesh, 'new-skydome')!);
    }

    public prepareToRender(globals: TheWitnessGlobals, renderInstManager: GfxRenderInstManager): void {
        setMatrixTranslation(this.model_matrix, globals.viewpoint.cameraPos);
        this.mesh_instance.prepareToRender(globals, renderInstManager, this, 0);
    }
}

export class TheWitnessRenderer implements SceneGfx {
    public renderHelper: GfxRenderHelper;

    private skydome: Skydome;

    constructor(device: GfxDevice, private globals: TheWitnessGlobals) {
        this.renderHelper = new GfxRenderHelper(device);
        this.skydome = new Skydome(globals);
    }

    public adjustCameraController(c: CameraController): void {
        c.setSceneMoveSpeedMult(1/100);
    }

    private prepareToRender(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        const viewpoint = this.globals.viewpoint;

        viewpoint.setupFromCamera(viewerInput.camera);
        let offs = template.allocateUniformBuffer(TheWitnessProgram.ub_SceneParams, 28);
        const d = template.mapUniformBufferF32(TheWitnessProgram.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, viewpoint.clipFromWorldMatrix);
        offs += fillVec3v(d, offs, viewpoint.cameraPos);

        const sun_x = 1.0, sun_y = -0.3, sun_z = 0.88;
        offs += fillVec4(d, offs, sun_x, sun_y, sun_z);
        offs += fillVec4(d, offs, 32, 32, 32);

        // Start with the skydome.
        this.skydome.prepareToRender(this.globals, this.renderHelper.renderInstManager);

        // Go through each entity and render them.
        for (let i = 0; i < this.globals.entity_manager.entity_list.length; i++)
            this.globals.entity_manager.entity_list[i].prepareToRender(this.globals, this.renderHelper.renderInstManager);

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput) {
        viewerInput.camera.setClipPlanes(0.1);

        const renderInstManager = this.renderHelper.renderInstManager;
        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
    }
}