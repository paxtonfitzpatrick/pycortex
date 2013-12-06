var dataset = (function(module) {
    module.filtertypes = { 
        nearest: THREE.NearestFilter, 
        trilinear: THREE.LinearFilter, 
        nearlin: THREE.LinearFilter, 
        debug: THREE.NearestFilter 
    };

    module.samplers = {
        trilinear: "trilinear",
        nearest: "nearest",
        nearlin: "nearest",
        debug: "debug",
    };

    module.brains = {}; //Singleton containing all BrainData objects

    module.makeFrom = function(dvx, dvy) {
        //Generate a new DataView given two existing ones
        var json = {};
        json.name = dvx.name + " vs. "+ dvy.name;
        json.data = [[dvx.data[0].name, dvy.data[0].name]];
        json.description = "2D colormap for "+dvx.name+" and "+dvy.name;
        json.cmap = [viewopts.default_2Dcmap];
        json.vmin = [[dvx.vmin[0][0], dvy.vmin[0][0]]];
        json.vmax = [[dvx.vmax[0][0], dvy.vmax[0][0]]];
        json.attrs = dvx.attrs;
        json.state = dvx.state;
        return new module.DataView(json);
    };

    module.DataView = function(json) {
        this.data = [];
        //Only handle 2D case for now -- muliviews are difficult to handle in this framework
        for (var i = 0; i < json.data.length; i++) {
            if (json.data[i] instanceof Array) {
                this.data.push(module.brains[json.data[i][0]]);
                this.data.push(module.brains[json.data[i][1]]);
            } else {
                this.data.push(module.brains[json.data[i]]);
            }
        }
        this.name = json.name;
        this.description = json.desc;
        this.attrs = json.attrs;
        this.state = json.state;
        this.loaded = $.Deferred().done(function() { $("#dataload").hide(); });
        this.rate = json.attrs.rate === undefined ? 1 : json.attrs.rate;
        this.delay = json.attrs.delay === undefined ? 0 : json.attrs.delay;
        this.filter = json.attrs.filter === undefined ? "nearest" : json.attrs.filter;
        if (json.attrs.stim !== undefined)
            this.stim = "stim/"+json.attrs.stim;

        var vmin = json.vmin;
        var vmax = json.vmax;
        var cmap = json.cmap;
        if (!(vmin instanceof Array))
            vmin = [[json.vmin]];
        if (!(vmax instanceof Array))
            vmax = [[json.vmax]];
        if (!(cmap instanceof Array))
            cmap = [json.cmap];

        this.cmap = [];
        this.vmin = [];
        this.vmax = [];
        for (var i = 0; i < this.data.length; i++) {
            this.cmap.push({ type:'t', value:4, texture: colormaps[cmap[i]]});
            this.vmin.push({ type:'fv1', value:[vmin[i][0],vmin[i][1] || 0] });
            this.vmax.push({ type:'fv1', value:[vmax[i][0],vmax[i][1] || 0] });
        }

        this.frames = this.data[0].frames
        this.length = this.frames / this.rate;

        this.uniforms = {
            framemix:   { type:'f',   value:0},
            data:       { type:'tv',  value:0, texture: [null, null, null, null]},
            mosaic:     { type:'v2v', value:[new THREE.Vector2(6, 6), new THREE.Vector2(6, 6)]},
            dshape:     { type:'v2v', value:[new THREE.Vector2(100, 100), new THREE.Vector2(100, 100)]},
            volxfm:     { type:'m4v', value:[new THREE.Matrix4(), new THREE.Matrix4()] },

            dataAlpha:  { type:'f', value:1.0},
        }
    }
    module.DataView.prototype.setVminmax = function(min, max, dim, idx) {
        if (dim === undefined)
            dim = 0;

        if (idx === undefined) {
            for (var i = 0; i < this.data.length; i++) {
                this.vmin[i][dim] = min;
                this.vmax[i][dim] = max;
            }
        } else {
            this.vmin[idx][dim] = min;
            this.vmax[idx][dim] = max;
        }
    }
    module.DataView.prototype.setColormap = function(cmap, idx) {
        if (idx === undefined) {
            for (var i = 0; i < this.data.length; i++) {
                this.cmap[i] = colormaps[cmap];
            }
        } else {
            this.cmap[idx] = colormaps[cmap];
        }
    }
    module.DataView.prototype.getShader = function(shaderfunc, uniforms, opts) {
        if (this.loaded.state() == "pending")
            $("#dataload").show();

        var shaders = [];
        for (var i = 0; i < this.data.length; i++) {
            //Run a shallow merge on the uniform variables
            var merge = {};
            for (var name in uniforms)
                merge[name] = uniforms[name];
            for (var name in this.uniforms)
                merge[name] = this.uniforms[name];
            merge.cmap = this.cmaps[i];
            merge.vmin = this.vmin[i];
            merge.vmax = this.vmax[i];

            var sampler = module.samplers[this.filter];
            var shadecode = shaderfunc(sampler, this.data[0].raw, this.data.length > 1, viewopts.voxlines, opts);
            var shader = new THREE.ShaderMaterial({ 
                vertexShader:shadecode.vertex,
                fragmentShader:shadecode.fragment,
                attributes: shadecode.attrs,
                uniforms: merge,
                lights:true, 
                blending:THREE.CustomBlending,
            });
            shader.metal = true;
            shaders.push(shader);
        }

        //Run set up when the datasets are loaded
        var allready = [];
        for (var i = 0; i < this.data.length; i++) {
            allready.push(false);
        }

        //Temporarily only support 2D dataviews
        var deferred = this.data.length == 1 ? 
            $.when(this.data[0].loaded) : 
            $.when(this.data[0].loaded, this.data[1].loaded);
        deferred.done(function() {
            this.loaded.resolve();

            for (var i = 0; i < this.data.length; i++) {
                this.data[i].init(this.uniforms, i);
                this.data[i].setFilter(this.filter);
                this.data[i].set(this.uniforms, i, 0);
            }
        }.bind(this)).progress(function() {
            for (var i = 0; i < this.data.length; i++) {
                if (this.data[i].textures.length > this.delay && !allready[i]) {
                    this.data[i].setFilter(this.filter);
                    this.data[i].set(this.uniforms, i, 0);
                    allready[i] = true;

                    //Resolve this deferred if ALL the BrainData objects are loaded (for multiviews)
                    var test = true;
                    for (var i = 0; i < allready.length; i++)
                        test = test && allready[i];
                    if (test)
                        this.loaded.resolve();
                }
            }
        }.bind(this));
        return shaders;
    }
    module.DataView.prototype.set = function(time) {
        var frame = ((time + this.delay) * this.rate).mod(this.frames);
        var fframe = Math.floor(frame);
        this.uniforms.framemix.value = frame - fframe;
        for (var i = 0; i < this.data.length; i++) {
            this.data[i].set(uniforms, i, fframe);
        }
    };
    module.DataView.prototype.setFilter = function(interp) {
        this.filter = interp;
        for (var i = 0; i < this.data.length; i++)
            this.data[i].setFilter(interp);
    }

    module.BrainData = function(json, images) {
        this.loaded = $.Deferred();
        this.xfm = json.xfm;
        this.subject = json.subject;
        this.movie = json.movie;
        this.raw = json.raw;
        this.min = json.min;
        this.max = json.max;
        this.mosaic = json.mosaic;
        this.name = json.data;

        this.data = images[json.data];
        this.frames = images[json.data].length;

        this.textures = [];
        var loadmosaic = function(idx) {
            var img = new Image();
            img.addEventListener("load", function() {
                var tex;
                if (this.raw) {
                    tex = new THREE.Texture(img);
                    tex.premultiplyAlpha = true;
                } else {
                    var canvas = document.createElement("canvas");
                    var ctx = canvas.getContext('2d');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    var im = ctx.getImageData(0, 0, img.width, img.height).data;
                    var arr = new Float32Array(im.buffer);
                    tex = new THREE.DataTexture(arr, img.width, img.height, THREE.LuminanceFormat, THREE.FloatType);
                    tex.premultiplyAlpha = false;
                }
                tex.minFilter = module.filtertypes['nearest'];
                tex.magfilter = module.filtertypes['nearest'];
                tex.needsUpdate = true;
                tex.flipY = false;
                this.shape = [((img.width-1) / this.mosaic[0])-1, ((img.height-1) / this.mosaic[1])-1];
                this.textures.push(tex);

                if (this.textures.length < this.frames) {
                    this.loaded.notify(this.textures.length);
                    loadmosaic(this.textures.length);
                } else {
                    this.loaded.resolve();
                }
            }.bind(this));
            img.src = this.data[this.textures.length];
        }.bind(this);

        loadmosaic(0);
        module.brains[json.data] = this;
    };
    module.BrainData.prototype.setFilter = function(interp) {
        //this.filter = interp;
        for (var i = 0, il = this.textures.length; i < il; i++) {
            this.textures[i].minFilter = module.filtertypes[interp];
            this.textures[i].magFilter = module.filtertypes[interp];
            this.textures[i].needsUpdate = true;
        }
    };
    module.BrainData.prototype.init = function(uniforms, dim) {
        var xfm = uniforms.volxfm.value[dim];
        xfm.set.apply(xfm, this.xfm);
        uniforms.mosaic.value[dim].set(this.mosaic[0], this.mosaic[1]);
        uniforms.dshape.value[dim].set(this.shape[0], this.shape[1]);
    };
    module.BrainData.prototype.set = function(uniforms, dim, fframe) {
        if (uniforms.data.texture[dim*2] !== this.textures[fframe]) {
            uniforms.data.texture[dim*2] = this.textures[fframe];
            if (this.frames > 1) {
                uniforms.data.texture[dim*2+1] = this.textures[(fframe+1).mod(this.frames)];
            } else {
                uniforms.data.texture[dim*2+1] = null;
            }
        }
    }
    module.fromJSON = function(dataset) {
        for (var name in dataset.data) {
            new module.BrainData(dataset.data[name], dataset.images);
        }
        var dataviews = [];
        for (var i = 0; i < dataset.views.length; i++) {
            dataviews.push(new module.DataView(dataset.views[i]));
        }
        return dataviews;
    }

    return module;
}(dataset || {}));