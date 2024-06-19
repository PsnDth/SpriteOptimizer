function basename(name) {
    return name.replace(/\.[^/.]+$/, "")
}

function toRadians (angle) {
return angle * (Math.PI / 180);
}

async function applyForFolder(dirHandle, func, path="") {
    path = `${path}/${dirHandle.name}`;
    allRet = [];
    for await (const entry of dirHandle.values()) {
        if (entry.kind == 'file') {
            allRet.push(await func(entry, dirHandle, path));
        }
        else if (entry.kind == 'directory') {
            // recursion should be optional and have a max depth
            allRet = allRet.concat(await applyForFolder(entry, func, path));
        }
    }
    return allRet;
}

/// Just some helpers around glMatrix
class Matrix {
    constructor() {
        this.mat = glMatrix.mat2d.create();
    }

    translate(translation) {
        glMatrix.mat2d.translate(this.mat, this.mat, translation);
    }
    scaleRotate(scale, angle, pivot) {
        if (pivot) this.translate(pivot);
        this.scale(scale);
        this.rotate(angle);
        if (pivot) {
            let neg_pivot = glMatrix.vec2.create();
            glMatrix.vec2.negate(neg_pivot, pivot);
            this.translate(neg_pivot);
        }

    }
    rotate(angle, pivot) {
        if (pivot) this.translate(pivot);
        glMatrix.mat2d.rotate(this.mat, this.mat, toRadians(angle));
        if (pivot) {
            let neg_pivot = glMatrix.vec2.create();
            glMatrix.vec2.negate(neg_pivot, pivot);
            this.translate(neg_pivot);
        }
    }
    scale(scale, pivot) {
        if (pivot) this.translate(pivot);
        glMatrix.mat2d.scale(this.mat, this.mat, scale);
        if (pivot) {
            let neg_pivot = glMatrix.vec2.create();
            glMatrix.vec2.negate(neg_pivot, pivot);
            this.translate(neg_pivot);
        }
    }
    apply(vec) {
        const ret = glMatrix.vec2.create();
        glMatrix.vec2.transformMat2d(ret, vec, this.mat);
        return ret;
    }

    static getVec(x, y) {
        return glMatrix.vec2.fromValues(x, y);
    }
}

class GuidInfo {
    constructor (guid, img_handle, parent_handle) {
        this.guid = guid;
        this.handle = img_handle;
        this.dir = parent_handle;
        this.width = null;
        this.height = null;
        this.crop_bounds = null;

    }

    updateSymbol(symbol) {
        if (this.crop_bounds == null) return;
        const crop_start = Matrix.getVec(this.crop_bounds[0], this.crop_bounds[1]);
        let corner = Matrix.getVec(symbol["x"], symbol["y"]);
        let pivot = Matrix.getVec(symbol["pivotX"], symbol["pivotY"]);
        const og_pivot = glMatrix.vec2.clone(pivot);
        const rotation = symbol["rotation"];
        
        const clean_scale_x = symbol["scaleX"] == 0 ? 1 : symbol["scaleX"];
        const clean_scale_y = symbol["scaleY"] == 0 ? 1 : symbol["scaleY"];
        const scale = Matrix.getVec(clean_scale_x, clean_scale_y);
        const inv_scale = glMatrix.vec2.create();
        glMatrix.vec2.inverse(inv_scale, scale);
        // Setup transformation for symbol
        
        // Update pivot to be global instead of relative
        let pivot_mat = new Matrix();
        pivot_mat.rotate(rotation);
        pivot_mat.scale(scale);
        let global_pivot = pivot_mat.apply(pivot);
        glMatrix.vec2.add(global_pivot, global_pivot, corner);

        // Update original pivot to account for new scale 
        glMatrix.vec2.subtract(pivot, pivot, crop_start);
        
        // Apply forward transform but using new pivot
        let restore_mat = new Matrix();
        restore_mat.rotate(rotation);
        restore_mat.scale(scale);
        glMatrix.vec2.subtract(corner, global_pivot, restore_mat.apply(pivot));

        symbol["x"] = corner[0];
        symbol["y"] = corner[1];
        // pivot was at 0, 0  then scale tweens will move the image 
        // while previously it just scaled it - need to think more about this
        // if the above is true, then need to account for this if there's rotation tweens combined with scale tweens
        if (!(symbol["pivotX"] == 0 && symbol["pivotY"] == 0)) {
            symbol["pivotX"] = pivot[0];
            symbol["pivotY"] = pivot[1];
        }
    }

    async getImage() {
        const img_reader = new FileReader();
        const img_file = await this.handle.getFile();
        return new Promise((resolve, reject) => {
            img_reader.onload = (e) => resolve(e.target.result);
            img_reader.onerror = reject;
            img_reader.readAsArrayBuffer(img_file);
        });
    }
    async updateImage(new_contents) {
        const img_file = await this.handle.createWritable();
        await img_file.write(new_contents);
        await img_file.close();
    }
    async loadMaxCrop() {
        const img = await Jimp.read(await this.getImage());
        let pixels = img.bitmap.data;
        let min_x = img.bitmap.width; // yes these are swapped, min/max will by default be the first non-transparent pixel found
        let max_x = 0;
        let min_y = img.bitmap.height;
        let max_y = 0;
        img.scan(0, 0, img.bitmap.width, img.bitmap.height, (x, y, i) => {
            if (pixels[i+3] > 0) {
                max_x = Math.max(max_x, x+1);
                max_y = Math.max(max_y, y+1);
                min_x = Math.min(min_x, x);
                min_y = Math.min(min_y, y);
            }
        });
        if (min_x >= max_x || min_y >= max_y) {
            console.warn("Found fully transparent image!");
            return;
        }
        this.width = img.bitmap.width;
        this.height = img.bitmap.height;
        if (max_x - min_x > this.width || max_y - min_y > this.height)
            throw `ERROR: Invalid scenario width=${this.width} height=${this.height} min_x=${min_x} max_x=${max_x} min_y=${min_y} max_y=${max_y}`
        if (!(max_x - min_x == this.width && max_y - min_y == this.height))
            this.crop_bounds = [min_x, min_y, max_x, max_y];
    }
    // Update to the maximum crop that includes both images
    updateCrop(other_img) {
        const other_bounds = other_img.crop_bounds;
        if (this.crop_bounds === null) return; // Nothing to do
        if (other_bounds === null) {
            // do not crop here either then
            this.crop_bounds = null;
            return;
        }
        const new_bounds = [
            Math.min(other_bounds[0], this.crop_bounds[0]),
            Math.min(other_bounds[1], this.crop_bounds[1]),
            Math.max(other_bounds[2], this.crop_bounds[2]),
            Math.max(other_bounds[3], this.crop_bounds[3]),
        ];
        this.crop_bounds = new_bounds;
    }
    async cropImage() {
        if (this.crop_bounds === null) return; // Nothing to do
        const handle_err = (err) => { if (err === null) return false; throw err; }
        const jimp_crop = [this.crop_bounds[0], this.crop_bounds[1], this.crop_bounds[2] - this.crop_bounds[0], this.crop_bounds[3] - this.crop_bounds[1]];
        const img = await Jimp.read(await this.getImage());
        const buffer = await img.crop(...jimp_crop, handle_err).getBufferAsync(Jimp.MIME_PNG);
        await this.updateImage(buffer);
    }
    getCroppedSize() {
        if (this.crop_bounds == null) return [this.width, this.height];
        return [this.crop_bounds[2] - this.crop_bounds[0], this.crop_bounds[3] - this.crop_bounds[1]];
    }
}

class ImageCropper {
    static ALIGN_TYPE_NAME = "alignType"
    static ALIGN_TYPE_ALIGNED = "aligned"
    static ALIGN_TYPE_NONE = "none"
    
    constructor() {
        this.name_info = new Map(); // temporarily maps filename to handle or guid depending on the order things are encountered
        this.guid_info = new Map(); // maps guid to handle, crop amount
    }

    async loadImgGuids(dirHandle) {
        await applyForFolder(dirHandle, async (fhandle, parentDir, path) => {
            if (fhandle.name.endsWith(".png.meta")) {
                const meta_file = await fhandle.getFile();
                const guid = JSON.parse(await meta_file.text())["guid"];
                const png_name = `${path}/${meta_file.name.slice(0, -5)}`;
                if (this.name_info.has(png_name)) {
                    let fhandle = this.name_info.get(png_name);
                    this.guid_info.set(guid, new GuidInfo(guid, fhandle, parentDir));
                    this.name_info.delete(png_name);
                } else {
                    this.name_info.set(png_name, guid);
                    
                }
            }
            if (fhandle.name.endsWith(".png")) {
                const png_name = `${path}/${fhandle.name}`;
                if (this.name_info.has(png_name)) {
                    let guid = this.name_info.get(png_name);
                    this.guid_info.set(guid, new GuidInfo(guid, fhandle, parentDir));
                    this.name_info.delete(png_name);
                } else {
                    this.name_info.set(png_name, fhandle);
                }
            }
        });
        if (this.name_info.size != 0)
            console.warn("Found some images with no corresponding meta file or vice-versa");
    }

    async cropAll(mode) {
        let seen_parents = []; 
        let alignment_groups = []; 
        for await (const guid of this.guid_info.keys()) {
            const guid_info = this.guid_info.get(guid);
            let found_match = false;
            let i = 0;
            for await (let parent of seen_parents) {
                if (mode != ImageCropper.ALIGN_TYPE_ALIGNED) break; // If not aligned put everything in their own group
                if (await guid_info.dir.isSameEntry(parent)) {
                    alignment_groups[i].push(guid);
                    found_match = true;
                    break;
                }
                i += 1;
            }
            if (!found_match) {
                seen_parents.push(guid_info.dir);
                alignment_groups.push([guid]);
            }
        }
        for await (const group of alignment_groups) {
            const first_guid_info = this.guid_info.get(group[0]);
            for await (const guid of group) {
                const guid_info = this.guid_info.get(guid);
                console.log(`Finding cropped size for ${guid_info.handle.name}`);
                await guid_info.loadMaxCrop();
                first_guid_info.updateCrop(guid_info); // stretch first crop
            }
            for await (const guid of group) {
                const guid_info = this.guid_info.get(guid);
                guid_info.updateCrop(first_guid_info);  // make everything match this first one
                console.log(`Actually cropping image for ${guid_info.handle.name}. Old: ${[guid_info.width, guid_info.height]} new: ${guid_info.getCroppedSize()}`);
                await guid_info.cropImage();
            }
        }
    }

    async updateEntityFiles(dirHandle) {
        await applyForFolder(dirHandle, async (fhandle) => {
            if (fhandle.name.endsWith(".entity")) {
                let entity_file = await fhandle.getFile();
                let entity_json = JSON.parse(await entity_file.text());
                for (let symbol of entity_json["symbols"]) {
                    const guid = symbol["imageAsset"];
                    if (guid) {
                        if (!this.guid_info.has(guid)) {
                            console.warn("Found image GUID that doesn't have corresponding image");
                            continue;
                        }
                        this.guid_info.get(guid).updateSymbol(symbol);
                    }
                }
                entity_file = await fhandle.createWritable();
                entity_file.write(JSON.stringify(entity_json, null, 2));
                entity_file.close();
            }
        });
    }

    async load(dirHandle) {
        console.log("loading guids");
        await this.loadImgGuids(dirHandle);
        console.log(`loaded guids=${this.guid_info.size}`);
        console.log(`cropping loaded images`);
        await this.cropAll(document.querySelector(`input[name="${ImageCropper.ALIGN_TYPE_NAME}"]:checked`).value);
        console.log(`Updating entity files`);
        await this.updateEntityFiles(dirHandle);
        console.log(`Done`);
    }
}

async function handleClickOrDrag(button, cb) {
        button.addEventListener("click", async (e) => {
            button.disabled = true;
            window.showDirectoryPicker({ id: "ft_folder", mode: "readwrite" }).then(cb);
        });
        document.addEventListener("drop",  async (e) => {
            if (button.disabled) return;
            button.disabled = true;
            getDraggedItems(e.dataTransfer.items).then(cb);
        });
}
async function getDraggedItems(items) {
    if (items.length > 1 ) throw "Error: Dragged more than 1 file, expected single fraytools project";
    for (const item of items) {
        if (item.kind != "file") throw "Error: Dragged input was not a directory, expecting Fraytools project folder";
        const entry = await item.getAsFileSystemHandle(); 
        if (entry.kind != "directory") throw "Error: Dragged input was not a directory, expecting Fraytools project folder";
        return entry;
    }
}
async function testWritableFraytoolsFolder(dirHandle) {
    for await (const entry of dirHandle.values()) {
        if (entry.name.endsWith(".fraytools")) {
            const testWriter = await entry.createWritable();
            return dirHandle;
        }
    }
    throw "Couldn't find .fraytools file";
}

window.addEventListener("load", (e) => {
    const result_box = document.getElementById("result");
    const start_button = document.getElementById("start_process");
    const can_modify_fs = ("showDirectoryPicker"  in window);
    if (!can_modify_fs) {
        start_button.disabled = true;
        result_box.textContent = "Can't access the filesystem directly with this browser 😢. Try using something chromium ...";
        result_box.classList = "desc error_resp";
        console.error(`showDirectoryPicker is not supported in this browser`);
        return;
    }
    handleClickOrDrag(start_button, async (start_folder) => {
        const cropper = new ImageCropper();
        testWritableFraytoolsFolder(start_folder)
        .then((dirHandle) => {
            result_box.classList = "desc info_resp";
            result_box.textContent = "Cropping Images/Updating Entity Files...";
            return dirHandle;
        })
        .then(cropper.load.bind(cropper))
        .then(() => {
            start_button.disabled = false;
            result_box.classList = "desc success_resp";
            result_box.textContent = "Successfully optimized blank space in project!";
        })
        .catch((err) => {
            start_button.disabled = false;
            if (err instanceof DOMException && err.name == "NotAllowedError") {
                err = "ERROR: Could not modify files in your project. Allow the site to modify if a popup appears.\r\nIf not, this browser does not support modifying directories 😢, try something chromium."
            }
            result_box.textContent = `${err}`;
            result_box.classList = "desc error_resp";
            console.error(err);
        });
    });
        
    document.addEventListener("dragover", (e) => { e.preventDefault(); });
    document.addEventListener("drop", async (e) => {
        e.preventDefault();
    });
});
