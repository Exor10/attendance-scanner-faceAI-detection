# Face model goes here

This folder holds the TensorFlow.js model trained in
[`colab/Face_Recognition_Training.ipynb`](../colab/Face_Recognition_Training.ipynb).

After running the notebook and downloading `face_model_tfjs.zip`, extract its
contents **directly into this folder** so the files sit like this:

```
model/
├── model.json
├── group1-shard1of1.bin   (there may be several shard files)
└── README.md
```

`js/face.js` loads `model/model.json` in the browser when you switch the
scanner page to **Face Mode (AI)**. Until these files exist, Face Mode will
show "Face model not found".
